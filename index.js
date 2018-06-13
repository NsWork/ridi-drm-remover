const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const bplist = require('bplist-parser');
const gui = require('gui');
const mkdirp = require('mkdirp');
const unzip = require('unzip');
const username = require('username');

const windows = require('windows');

async function entrypoint() {
    const win = gui.Window.create({});
    {
        win.setContentSize({ width: 400, height: 100 });
        win.onClose = () => gui.MessageLoop.quit();
        win.setTitle('ridi-drm-remover');
        win.center();
        win.activate();
    }
    let dispose;
    const context = {
        savePath: path.join(process.cwd(), 'drm-removed'),
        goto(name) {
            if (!screens[name]) throw new Error(`screen not found: '${ name }'`);
            const screen = screens[name]({ win, context });
            dispose && dispose();
            win.setContentView(screen.view);
            dispose = screen.job && screen.job();
        },
    };
    context.goto('main');
}

const screens = {
    main({ win, context }) {
        const view = gui.Container.create();
        win.setContentView(view);
        /*
        {
            view.setBlendingMode('behind-window');
            view.setMaterial('dark');
            view.setStyle({
                flexDirection: 'column',
                justifyContent: 'center',
            });
        }
        */
        const openFileDialogButton = gui.Button.create('drm 제거된 파일들을 저장할 경로 변경');
        {
            openFileDialogButton.onClick = () => {
                const dialog = gui.FileOpenDialog.create();
                dialog.setOptions(gui.FileDialog.optionPickFolders | gui.FileDialog.optionShowHidden);
                if (dialog.runForWindow(win)) {
                    context.savePath = dialog.getResult();
                    savePathLabel.setText(context.savePath);
                }
            };
            view.addChildView(openFileDialogButton);
        }
        const noteLabel = gui.Label.create('다음의 경로에 저장됩니다:');
        {
            noteLabel.setAlign('center');
            //noteLabel.setColor('#fff');
            view.addChildView(noteLabel);
        }
        const savePathLabel = gui.Label.create(context.savePath);
        {
            savePathLabel.setAlign('center');
            //savePathLabel.setColor('#fff');
            view.addChildView(savePathLabel);
        }
        const runButton = gui.Button.create('drm 제거 시작');
        {
            runButton.onClick = () => context.goto('run');
            view.addChildView(runButton);
        }
        return { view };
    },
    run({ win, context }) {
        const view = gui.Container.create();
        win.setContentView(view);
        /*
        {
            view.setBlendingMode('behind-window');
            view.setMaterial('dark');
            view.setStyle({
                flexDirection: 'column',
                justifyContent: 'center',
            });
        }
        */
        const noteLabel = gui.Label.create('작업 준비중');
        {
            noteLabel.setAlign('center');
            //noteLabel.setColor('#fff');
            view.addChildView(noteLabel);
        }
        const progressBar = gui.ProgressBar.create();
        {
            progressBar.setIndeterminate(true);
            view.addChildView(progressBar);
        }
        return {
            view,
            async job() {
                const systemUsername = await username();
                const deviceId = await getDeviceId(systemUsername);
                const jobs = await prepareJobs(systemUsername);
                progressBar.setIndeterminate(false);
                progressBar.setValue(0);
                for (let i = 0; i < jobs.length; ++i) {
                    const [ridiUsername, bookId] = jobs[i];
                    const libraryPath = getLibraryPath(systemUsername, ridiUsername);
                    const savePath = path.join(context.savePath, ridiUsername);
                    progressBar.setValue((i / jobs.length) * 100);
                    noteLabel.setText(`${ ridiUsername }, ${ bookId } 작업중...`);
                    let type, fd;
                    try {
                        [type, fd] = await openEbook(libraryPath, bookId);
                        await asyncMkdirp(savePath);
                    } catch (e) {
                        //console.error(e);
                        continue;
                    }
                    console.log(bookId, type);
                    if (type === 'zip') {
                        await saveZipTypeEbook(deviceId, fd, path.join(savePath, bookId));
                    } else {
                        const contentKey = await decryptKeyFile(deviceId, libraryPath, bookId);
                        switch (type) {
                        case 'pdf': await savePdfTypeEbook(contentKey, fd, path.join(savePath, `${ bookId }.pdf`)); break;
                        case 'epub': await saveEpubTypeEbook(contentKey, fd, path.join(savePath, `${ bookId }.epub`)); break;
                        }
                    }
                }
                progressBar.setValue(100);
                noteLabel.setText('완료');
            }
        };
    },
};

/**
 * @returns {[string, string][]}
 */
async function prepareJobs(systemUsername) {
    const jobs = [];
    for (let ridiUsername of await getRidiUserNames(systemUsername)) {
        const libraryPath = getLibraryPath(systemUsername, ridiUsername);
        for (let bookId of await getChildFoldersShallow(libraryPath)) {
            jobs.push([ridiUsername, bookId]);
        }
    }
    return jobs;
}

async function savePdfTypeEbook(contentKey, fd, savePath) {
    const decipher = crypto.createDecipheriv(
        'aes-128-cbc',
        contentKey,
        Buffer.alloc(16, 0),
    );
    const data = decipher.update(await asyncReadFile(fd)).slice(16);
    await asyncWriteFile(savePath, data);
}

async function saveEpubTypeEbook(contentKey, fd, savePath) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', contentKey, '');
    const data = decipher.update(await asyncReadFile(fd));
    await asyncWriteFile(savePath, data);
}

function saveZipTypeEbook(deviceId, fd, savePath) {
    async function decryptAndSavePage(pageStream, deviceId, savePath) {
        const decipher = crypto.createDecipheriv('aes-128-ecb', deviceId.substring(2, 18), '');
        const data = decipher.update(await streamToBuffer(pageStream));
        await asyncWriteFile(savePath, data);
    }
    return new Promise((resolve, reject) => {
        mkdirp(savePath, err => {
            if (err) return reject(err);
            const jobs = [];
            fs.createReadStream(null, { fd }).pipe(unzip.Parse()).on('entry', entry => {
                const [filePath, fileType] = [entry.path, entry.type];
                jobs.push(
                    fileType === 'File' ?
                    decryptAndSavePage(entry, deviceId, path.join(savePath, filePath)) :
                    drain(entry)
                );
            }).on('finish', () => Promise.all(jobs).then(resolve));
        });
    });
}

/**
 * @returns {Buffer}
 */
async function streamToBuffer(stream) {
    return new Promise(resolve => {
        const buffers = [];
        stream.on('data', buffer => buffers.push(buffer));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}

async function drain(stream) {
    return new Promise(resolve => {
        stream.on('readable', () => stream.read());
        stream.on('end', resolve);
    });
}

/**
 * @param {string} libraryPath 
 * @param {string} bookId 
 * @returns {['pdf' | 'epub' | 'zip', number]}
 */
async function openEbook(libraryPath, bookId) {
    for (let type of ['pdf', 'epub', 'zip']) {
        try {
            return [ type, await asyncOpen(
                path.join(libraryPath, bookId, `${ bookId }.${ type }`),
                'r',
            ) ];
        } catch (e) {
            continue;
        }
    }
    //throw new Error('unsupported ebook type');
}

async function getRidiUserNames(systemUsername) {
    return (await getChildFoldersShallow(`c:/Users/${ systemUsername }/AppData/Local/RIDI/Ridibooks/`)).filter(
        folder => (folder !== 'QtWebEngine') && (folder !== 'fontcache')
    );
}

function getLibraryPath(systemUsername, ridiUsername) {
    return `c:/Users/${ systemUsername }/AppData/Local/RIDI/Ridibooks/${ ridiUsername }/library`;
}

async function decryptKeyFile(deviceId, libraryPath, bookId) {
    const idLength = deviceId.length;
    const keyFilePath = path.join(libraryPath, bookId, `${ bookId }.dat`);
    const decKey = deviceId.substr(0, 16).replace(/-/g, '');
    const sc = new SimpleCrypt(decKey);
    const keyFile = await asyncReadFile(keyFilePath);
    const ecbKey = Buffer.from(deviceId.substr(0, 16), 'binary');
    const decipher = crypto.createDecipheriv('aes-128-ecb', ecbKey, '');
    const contentKey = decipher.update(
        Buffer.from(sc.decrypt(keyFile), 'binary')
    ).slice(idLength, idLength + 64).slice(32, 48);
    return contentKey;
}

function getDeviceId() {
    const deviceId = windows.registry('HKCU/Software/RIDI/Ridibooks/device').device_id;
    const sc = new SimpleCrypt('0c2f1bb4acb9f023');
    return sc.decrypt(Buffer.from(deviceId, 'base64'));
}

const memo = [];
function asyncMkdirp(dir) {
    if (memo.includes(dir)) return;
    memo.push(dir);
    return new Promise((resolve, reject) => mkdirp(
        dir,
        (err, made) => err ? reject(err) : resolve(made),
    ));
}

const asyncOpen = promisify(fs.open);
const asyncReadFile = promisify(fs.readFile);
const asyncWriteFile = promisify(fs.writeFile);
const asyncReaddir = promisify(fs.readdir);
const asyncStat = promisify(fs.stat);

async function getChildFoldersShallow(dir) {
    const items = await asyncReaddir(dir);
    return (await Promise.all(
        items.map(async item => [item, await asyncStat(path.join(dir, item))])
    )).filter(
        ([item, stats]) => stats.isDirectory()
    ).map(([item]) => item);
}

class SimpleCrypt {
    constructor(key) {
        this._parts = key.match(/../g).map(part => parseInt(part, 16)).reverse();
    }
    /**
     * @param {string | Buffer} text
     */
    decrypt(text) {
        const ctext = (
            typeof text === 'string' ?
            Buffer.from(text, 'binary') :
            text
        ).slice(2);
        const pt = Buffer.alloc(ctext.length);
        let lc = 0;
        for (let i = 0; i < ctext.length; ++i) {
            const c = ctext.readUInt8(i);
            pt.writeUInt8(c ^ lc ^ this._parts[i % 8], i);
            lc = c;
        }
        return pt.slice(1).toString('binary').slice(2);
    }
}

entrypoint();
if (!process.versions.yode) {
    gui.MessageLoop.run();
    process.exit(0);
}
