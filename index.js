const DISABLE = 0

const express = require('express');
const json = require('body-parser').json;
const child_process = require('child_process');
const worker_threads = require('worker_threads');
const fs = require('fs');
const { getRemoteIP, getWebsiteUrl } = require('./utils.js');
const https = require('https');
const http = require('http');

const config = require('./config.json'); // 加载配置文件

/*======================================================================================
main 主线程
========================================================================================*/
function main() {
    let app = new express();
    app.use('/y2b', (req, res, next) => {
        if (DISABLE) {
            res.send({
                success: false,
                error: `暂停使用!`,
            });
        } else {
            next();
        }
    });
    app.use((req, res, next) => {
        console.log(`${getRemoteIP(req)}\t=>  ${req.url}`);
        let isBlackIP = false;
        try {
            let blackIPs = fs.readFileSync(config.blacklist).toString().split(/\s/);
            blackIPs.forEach(ip => {
                if (getRemoteIP(req) === ip) {
                    res.status(500);
                    res.send(`<div style='font-size: 33vw; text-align: center'>500</div>`);
                    console.log('黑名单IP！');
                    isBlackIP = true;
                    throw `黑名单 => ${ip}`;
                }
            });
        } catch(error) {
            //
        }
        if (!isBlackIP) next();
    });
    app.use('/', express.static(`${__dirname}/static`));
    app.use('/file', (req, res, next) => {
        console.log(`下载${req.url}`);
        let info = fs.readFileSync(`${__dirname}/tmp/${req.url.replace(/\.\w+$/, '.info.json')}`).toString();
        info = JSON.parse(info);
        console.log({'标题': info.title}); // or 'fulltitle'
        let ext = req.url.match(/.*(\.\w+)$/)[1];
        res.set({'Content-Disposition': `attachment; filename="${encodeURIComponent(info.title + ext)}"; filename*=UTF-8''${encodeURI(info.title + ext)}`});
        next();
    });
    app.use('/file', express.static(`${__dirname}/tmp`));
    app.use('/info', express.static(`${__dirname}/tmp`));
    app.use('/bili_file', express.static(`${__dirname}/bilibili`));

    app.get('/y2b/parse', (req, res) => {
        let url = req._parsedUrl.query;
        url = decodeURIComponent(url.replace('y2b', 'youtube').replace('y2', 'youtu')); // "链接已重置"大套餐
        console.log({ op: '解析', url });

        let y2b = url.match(/^https?:\/\/(?:youtu.be\/|(?:www|m).youtube.com\/(?:watch|shorts)(?:\/|\?v=))([\w-]{11})$/);
        let bilibili = url.match(/^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/([\w\d]{11,14})\/?(?:\?p=(\d+))?$/);
        let website;
        switch (true) {
            case y2b != null:
                website = 'y2b';
                break;
            case bilibili != null:
                website = 'bilibili';
                break;
        }
        if (!!! website) {
            console.log('reject');
            res.send({
                "error": "请提供一个Youtube视频URL<br>例如：<br>https://youtu.be/xxxxxxxxxxx<br>https://www.bilibili.com/video/xx",
                "success": false
            });
            return;
        }
        checkDisk(); // 解析视频前先检查磁盘空间

        let thread = new worker_threads.Worker(__filename);
        thread.once('message', msg => {
            // console.log(JSON.stringify(msg, null, 1));
            res.send(msg);
        });
        thread.postMessage({ op: 'parse', website, url, videoID: (y2b || bilibili)[1], p: bilibili?.[2] });
    });

    let queue = [];
    app.get('/y2b/download', (req, res) => {
        let { website, v, p, format, recode, subs } = req.query;
        if (!!!v.match(/^[\w-]{11,14}$/))
            return res.send({ "error": "Qurey参数v错误: 请提供一个正确的Video ID", "success": false });

        if (p && !!!p.match(/^[\d]+$/))
            return res.send({ "error": "Qurey参数p错误: 请提供一个正确的Part number", "success": false });

        if (!!!format.match(/^([\w\d-]+)(?:x([\w\d-]+))?$/))
            return res.send({ "error": "Query参数format错误: 请求的音频和视频ID必须是数字, 合并格式为'视频IDx音频ID'", "success": false });

        if (config.mode === '演示模式' && !!recode)
            return res.send({ "error": "演示模式，关闭转码功能<br>本项目已使用Node.js重写<br>请克隆本项目后自行部署", "success": false });

        if (subs && subs !== '' && !subs.match(/^([a-z]{2}(-[a-zA-Z]{2,4})?,?)+$/))
            return res.send({ "error": "字幕不正确!", "success": false });

        if (queue[JSON.stringify(req.query)] === undefined) {
            checkDisk(); // 下载视频前先检查磁盘空间

            queue[JSON.stringify(req.query)] = {
                "success": true,
                "result": {
                    "v": v,
                    "downloading": true,
                    "downloadSucceed": false,
                    "dest": "正在下载中",
                    "metadata": ""
                }
            };

            let thread = new worker_threads.Worker(__filename);
            thread.once('message', msg => {
                // 下载成功或失败，更新queue
                console.log('下载成功或失败，更新queue');
                console.log(JSON.stringify(msg, null, 1));
                queue[JSON.stringify(req.query)] = msg;
            });
            thread.postMessage({ op: 'download', website, videoID: v, p, format, recode, subs });
        } // if end
        // 发送轮询结果
        res.send(queue[JSON.stringify(req.query)]);
    }); // /youtube/download end

    // API: 下载字幕
    app.use(json());
    app.post('/y2b/subtitle', (req, res) => {
        let { website, id, p, locale, ext, type } = req.body;

        if (!id.match(/^[\w-]{11,14}$/) ||
            !ext.match(/^.(srt|ass|vtt|lrc|xml)$/) ||
            !type.match(/^(auto|native)$/) ||
            (p && !p.match(/^[\d]+$/)) ||
            // !locale.match(/^([a-z]{2}(-[a-zA-Z]{2,4})?)+$/) ||
            false
        ) {
            console.log('字幕请求预检被禁止, 可疑请求:', req.body);
            res.send({ success: false });
            return;
        }
        // checkDisk(); // 下载字幕前先检查磁盘空间
        let thread = new worker_threads.Worker(__filename); // 启动子线程
        thread.once('message', msg => {
            let { title, filename, text } = msg;
            // 下载字幕成功或失败
            if (msg.success) {
                console.log('字幕下载成功');
                res.send({ success: true, title, filename, text });
            } else {
                console.log('字幕下载失败');
                res.send({ success: false });
            }
        });
        thread.postMessage({ op: 'subtitle', website, id, p, locale, ext, type });
    }); // /youtube/subtitle end

    app.get('/pxy', (req, res) => {
        let url = req.query.url;
        if (!url.startsWith('https://i.ytimg.com/') && !url.match(/^https?:\/\/i\d\.hdslb\.com\//)) {
            res.status(403).end();
            return;
        }
        (url.startsWith('https://') ? https : http).get(url, (response) => {
            res.writeHead(response.statusCode, response.statusMessage, response.headers);
            response.pipe(res);
        }).on('error', (err) => {
            console.log(err);
            res.status(502).end();
        });
    });

    app.listen(config.port, config.address, () => {
        console.log('服务已启动');
    });

    /**
     * 检测磁盘空间, 必要时清理空间并清空队列queue
     */
    function checkDisk() {
        try {
            let df = child_process.execSync(`df -h .`).toString();
            df.split('\n').forEach(it => {
                console.log({ '空间': it });
                // /dev/sda2        39G   19G   19G  51% /
                let mr = it.match(/.*\s(\d+)%/);
                if (!!mr && Number.parseInt(mr[1]) > 90) {
                    let cmd = `rm -r '${__dirname}/tmp' '${__dirname}/bilibili'`;
                    console.log({ '清理空间': cmd });
                    child_process.execSync(cmd);
                    queue = [];
                }
            });
        } catch (error) {
            //
        }
    } // checkDisk()
} // main()



/*======================================================================================
Worker
========================================================================================*/
function getAudio(id, format, rate, info, size) {
    return { id, format, rate: rate == 0 ? '未知' : rate, info, size: size == 0 ? '未知' : size };
}

function getVideo(id, format, scale, frame, rate, info, size) {
    return { id, format, scale, frame, rate: rate == 0 ? '未知' : rate, info, size: size == 0 ? '未知' : size };
}

/**
 * 在以下形式的字符串中捕获字幕:
 * Language Name    Formats <= 返回0, 继续
 * gu       vtt, ttml, srv3, srv2, srv1
 * zh-Hans  vtt, ttml, srv3, srv2, srv1
 * en       English vtt, ttml, srv3, srv2, srv1, json3
 * 其它形式一律视为终结符, 返回-1, 终结
 * @param {String} line 
 */
function catchSubtitle(line) {
    if (line.match(/^Language .*/)) return 0;
    let mr = line.match(/^(danmaku|[a-z]{2}(?:-[a-zA-Z]+)?).*/);
    if (mr) return mr[1];
    return -1;
}

/**
 * 同步解析字幕
 * @param {{ op: 'parse', url: String, videoID: String }} msg 
 */
function parseSubtitle(msg) {
    try {
        let cmd = `yt-dlp --list-subs ${config.cookie !== undefined ? `--cookies "${config.cookie}"` : ''} '${msg.url}' 2> /dev/null`
        console.log(`解析字幕, 命令: ${cmd}`);
        let rs = child_process.execSync(cmd).toString().split(/(\r\n|\n)/);

        /** 是否没有自动字幕 */
        let noAutoSub = true;
        let officialSub = [];

        for (let i = 0; i < rs.length; i ++ ) {
            if (rs[i].trim() === '' || rs[i].trim() === '\n') continue; // 空行直接忽略
            // console.log('=>  ', rs[i]);
            // 排除一下连自动字幕都没有的, 那一定是没有任何字幕可用
            if (rs[i].match(/.*Available automatic captions for .*?:/)) { // ?表示非贪婪, 遇到冒号即停止
                noAutoSub = false; // 排除即可, 全都是把整个字幕列表输出一遍, 这部分不需要捕获
                continue;
            }
            // 解析官方字幕
            if (rs[i].match(/.*Available subtitles for .*?:/)) {
                FOR_J: // 打标签, 因为需要从switch中断
                for (let j = i + 1; j < rs.length; j ++ ) {
                    if (rs[j].trim() === '' || rs[j].trim() === '\n') continue; // 空行直接忽略
                    sub = catchSubtitle(rs[j]);
                    switch (sub) {
                        case -1: { // 终结
                            break FOR_J;
                        }
                        case 0: { // 继续
                            continue;
                        }
                        default: { // 捕获
                            officialSub.push(sub);
                            break;
                        }
                    }
                } // for j
            } // if
        } // for i

        if (officialSub.length < 1) { // 没有官方字幕
            if (noAutoSub) { // 没有任何字幕
                console.log('没有任何字幕');
                return [];
            } else { // 没有官方字幕但是有自动生成字幕, 可以自动翻译为任何字幕
                console.log('有自动生成字幕');
                return ['auto'];
            }
        } else { // 有官方字幕, 同时可以自动翻译为任何字幕
            console.log('有官方字幕');
            console.log(JSON.stringify(officialSub, null, 0));
            return officialSub;
        }
    } catch (error) {
        console.log(error); // npm 命令无法捕获error错误流
    }
    return [];
}

/**
 * Worker线程入口
 */
function task() {
    worker_threads.parentPort.once('message', msg => {
        switch (msg.op) {
            case 'subtitle': {
                console.log(msg);
                let { id, p, locale, ext, type, website } = msg;
                // 先下载字幕
                let fullpath = `${__dirname}/tmp/${id}${ p ? `/p${p}` : '' }`; // 字幕工作路径
                let cmd_download = '';
                if (type === 'native') // 原生字幕
                    cmd_download = `yt-dlp --sub-lang '${locale}' -o '${fullpath}/%(id)s.%(ext)s' --write-sub --skip-download --write-info-json ${getWebsiteUrl(website, id, p)} ${config.cookie !== undefined ? `--cookies ${config.cookie}` : ''}`;
                else if (type === 'auto') // 切换翻译通道
                    cmd_download = `yt-dlp --sub-lang '${locale}' -o '${fullpath}/%(id)s.%(ext)s' --write-auto-sub --skip-download --write-info-json ${getWebsiteUrl(website, id, p)} ${config.cookie !== undefined ? `--cookies ${config.cookie}` : ''}`;
                console.log(`下载字幕, 命令: ${cmd_download}`);
                try {
                    child_process.execSync(cmd_download); // 执行下载
                    // 文件前缀
                    let before = `${fullpath}/${id}${ p ? `_p${p}` : '' }`;
                    // 字幕文件路径
                    let file = `${before}.${locale}.${locale == 'danmaku' ? 'xml' : website == 'y2b' ? 'vtt' : 'srt'}`; // B站的字幕一定是srt格式, 或xml格式(B站弹幕)，y2b是vtt格式
                    console.log('下载的字幕:', file);
                    let file_convert = `${before}.${locale}${ext}`; // 要转换的字幕文件
                    if (file != file_convert) {
                        console.log('转换为:', file_convert);
                        let cmd_ffmpeg = `ffmpeg -i '${file}' '${file_convert}' -y`; // -y 强制覆盖文件
                        console.log(`转换字幕, 命令: ${cmd_ffmpeg}`);
                        child_process.execSync(cmd_ffmpeg);
                    }
                    // info文件路径
                    let file_info = `${before}.info.json`;
                    console.log('info文件:', file_info);
                    // JSON of info文件
                    let info = JSON.parse(fs.readFileSync(file_info).toString());
                    let title = info.title; // 视频标题
                    console.log('视频标题:', title);
                    let text = fs.readFileSync(file_convert).toString(); // 转换后字幕文件的文本内容
                    worker_threads.parentPort.postMessage({ // 下载成功
                        success: true,
                        title, // 返回标题
                        filename: `${title}.${locale}${ext}`, // 建议文件名
                        text: Buffer.from(text).toString('base64'), // 字幕文本，Base64
                    });
                } catch(error) { // 下载过程出错
                    console.log(error);
                }
                worker_threads.parentPort.postMessage({
                    success: false,
                });
                break;
            } // case subtitle end

            case 'parse': {
                let audios = [], videos = [];
                let bestAudio = {}, bestVideo = {};

                let rs = { title: '', thumbnail: '', formats: [] };
                try {
                    let cmd = `yt-dlp --print-json --skip-download ${config.cookie !== undefined ? `--cookies ${config.cookie}` : ''} '${msg.url}' 2> /dev/null`
                    console.log('解析视频, 命令:', cmd);
                    rs = child_process.execSync(cmd).toString();
                    try {
                        rs = JSON.parse(rs);
                    } catch (error) {
                        let cmd = `yt-dlp --print-json --skip-download ${config.cookie !== undefined ? `--cookies ${config.cookie}` : ''} '${msg.url}?p=1' 2> /dev/null`;
                        console.log('尝试分P, 命令:', cmd);
                        rs = child_process.execSync(cmd).toString();
                        rs = JSON.parse(rs);
                        msg.p = '1';
                        msg.url = `${msg.url}?p=1`;
                    }
                    console.log('解析完成:', rs.title, msg.url);
                } catch (error) {
                    console.log(error.toString());
                    worker_threads.parentPort.postMessage({
                        "error": "解析失败！",
                        "success": false
                    });
                    return;
                }

                rs.formats.forEach(it => {
                    let length = (it.filesize_approx ? '≈' : '') + ((it.filesize || it.filesize_approx || 0) / 1024 / 1024).toFixed(2);
                    if (it.audio_ext != 'none') {
                        audios.push(getAudio(it.format_id, it.ext, (it.abr || 0).toFixed(0), it.format_note || it.format || '', length));
                    } else if (it.video_ext != 'none') {
                        videos.push(getVideo(it.format_id, it.ext, it.resolution, it.height, (it.vbr || 0).toFixed(0), it.format_note || it.format || '', length));
                    }
                });

                // sort
                // audios.sort((a, b) => a.rate - b.rate);
                // videos.sort((a, b) => a.rate - b.rate);
                bestAudio = Array.from(audios).sort((a, b) => a.rate - b.rate)[audios.length - 1];
                bestVideo = Array.from(videos).sort((a, b) => a.rate - b.rate)[videos.length - 1];
                
                let subs = parseSubtitle(msg); // 解析字幕

                worker_threads.parentPort.postMessage({
                    "success": true,
                    "result": {
                        "website": msg.website,
                        "v": msg.videoID,
                        "p": msg.p,
                        "title": rs.title,
                        "thumbnail": rs.thumbnail,
                        "best": {
                            "audio": bestAudio,
                            "video": bestVideo,
                        },
                        "available": { audios, videos, subs }
                    }
                });

                break;
            }

            case 'download': {
                let { videoID, p, format, recode, subs, website } = msg; // subs字幕内封暂未实现
                const path = `${videoID}${ p ? `/p${p}` : '' }/${format}`;
                const fullpath = `${__dirname}/tmp/${path}`;
                let cmd = //`cd '${__dirname}' && (cd tmp > /dev/null || (mkdir tmp && cd tmp)) &&` +
                    `yt-dlp  ${config.cookie !== undefined ? `--cookies ${config.cookie}` : ''} ${getWebsiteUrl(website, videoID, p)} -f ${format.replace('x', '+')} ` +
                    `-o '${fullpath}/${videoID}.%(ext)s' ${recode !== undefined ? `--recode ${recode}` : ''} -k --write-info-json --no-playlist`;
                console.log('下载视频, 命令:', cmd);
                try {
                    let dest = 'Unknown dest';
                    let ps = child_process.execSync(cmd).toString().split('\n');
                    let regex = new RegExp(`^.*${fullpath}/(${videoID}\\.[\\w]+).*$`);
                    ps.forEach(it => {
                        console.log(it);
                        let mr = it.match(regex);
                        if (!!mr) {
                            dest = mr[1];
                        }
                    });
                    worker_threads.parentPort.postMessage({
                        "success": true,
                        "result": {
                            "v": videoID,
                            "downloading": false,
                            "downloadSucceed": true,
                            "dest": `file/${path}/${dest}`,
                            "metadata": `info/${path}/${videoID}.info.json`
                        }
                    });
                } catch (error) {
                    let cause = 'Unknown cause';
                    console.log({error});
                    error.toString().split('\n').forEach(it => {
                        console.log(it);
                        let mr = it.match(/^.*(ERROR.*)$/);
                        if (!!mr) {
                            cause = mr[1];
                        }
                    });
                    worker_threads.parentPort.postMessage({
                        "success": true,
                        "result": {
                            "v": "demoVideoID",
                            "downloading": false,
                            "downloadSucceed": false,
                            "dest": "下载失败",
                            "metadata": cause
                        }
                    });
                } // end of try

                break;
            } // end of download
        } // end of switch
    });
}

/*======================================================================================
index.js 兵分两路
========================================================================================*/
if (worker_threads.isMainThread)
    main();
else
    task();
/*======================================================================================*/
