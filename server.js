const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const IS_MAC = process.platform === 'darwin';
const HID_BIN = path.join(__dirname, 'mac_hid');
const HID_SRC = path.join(__dirname, 'mac_hid.m');
const FAVORITES_FILE = path.join(__dirname, 'favorites.json');

// CORS & Private Network Access 허용 (https://movie.memorypassport.kr -> http://127.0.0.1:3000 브릿지 지원)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

app.use(express.json());
app.use(express.static('public'));

// 기본 즐겨찾기 / 주크박스 목록
const DEFAULT_FAVORITES = [
    { id: 'tving-home', title: '티빙 홈', icon: '💗', platform: 'TVING', url: 'https://www.tving.com' },
    { id: 'netflix-home', title: '넷플릭스 홈', icon: '🔴', platform: 'NETFLIX', url: 'https://www.netflix.com/browse' },
    { id: 'tving-live', title: '티빙 실시간 TV', icon: '📺', platform: 'TVING', url: 'https://www.tving.com/live' },
    { id: 'tving-series', title: '티빙 인기 예능·시리즈', icon: '🔥', platform: 'TVING', url: 'https://www.tving.com/series' },
    { id: 'netflix-top10', title: '넷플릭스 TOP 10 신작', icon: '🏆', platform: 'NETFLIX', url: 'https://www.netflix.com/latest' },
    { id: 'netflix-series', title: '넷플릭스 시리즈·드라마', icon: '🍿', platform: 'NETFLIX', url: 'https://www.netflix.com/browse/genre/83' },
    { id: 'netflix-movies', title: '넷플릭스 영화', icon: '🎬', platform: 'NETFLIX', url: 'https://www.netflix.com/browse/genre/34399' },
    { id: 'coupang-home', title: '쿠팡플레이', icon: '💙', platform: 'COUPANG', url: 'https://www.coupangplay.com' },
    { id: 'youtube-home', title: '유튜브 홈', icon: '▶️', platform: 'YOUTUBE', url: 'https://www.youtube.com' }
];

function loadFavorites() {
    try {
        if (fs.existsSync(FAVORITES_FILE)) {
            const data = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
            if (Array.isArray(data) && data.length > 0) return data;
        }
    } catch (e) {
        console.error('Failed to load favorites:', e.message);
    }
    return [...DEFAULT_FAVORITES];
}

function saveFavorites(list) {
    try {
        fs.writeFileSync(FAVORITES_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save favorites:', e.message);
    }
}

let favoritesList = loadFavorites();

// 원격 제어 명령 큐 (클라우드 Render 서버 <-> 맥북 로컬 컨트롤러 동기화용)
const remoteCommandQueue = [];
const executedCommandIds = new Set();

function enqueueRemoteCommand(cmd) {
    if (!cmd || !cmd.id) return;
    if (!remoteCommandQueue.some(item => item.id === cmd.id)) {
        remoteCommandQueue.push({
            ...cmd,
            ts: cmd.ts || Date.now()
        });
        if (remoteCommandQueue.length > 100) {
            remoteCommandQueue.shift();
        }
    }
}

// ====================================================
// macOS 전용: 절전 방지(caffeinate) 및 네이티브 마우스/크롬 제어
// ====================================================
if (IS_MAC) {
    // 1. mac_hid 바이너리가 없으면 자동 컴파일
    if (!fs.existsSync(HID_BIN) && fs.existsSync(HID_SRC)) {
        execFile('/usr/bin/clang', ['-framework', 'ApplicationServices', '-framework', 'Foundation', HID_SRC, '-o', HID_BIN], (err) => {
            if (err) console.error('mac_hid compile error:', err.message);
            else console.log('✅ mac_hid native controller compiled');
        });
    }

    // 2. 외출 중 맥북 화면 꺼짐 / 잠자기 모드 완벽 방지
    try {
        const caff = spawn('/usr/bin/caffeinate', ['-di', '-w', String(process.pid)], {
            stdio: 'ignore',
            detached: true
        });
        caff.unref();
        console.log('☕ caffeinate 활성화 완료: 외출 중에도 맥북이 절전 모드로 들어가지 않습니다.');
    } catch (e) {
        console.error('caffeinate error:', e.message);
    }

    // 3. minji.memorypassport.kr 전용 Cloudflare 터널이 안 켜져 있으면 자동 실행
    execFile('/usr/bin/pgrep', ['-f', 'config_memorypassport.yml'], (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
            const cfBin = '/opt/homebrew/bin/cloudflared';
            const cfCfg = '/Users/lemonpapa/.cloudflared/config_memorypassport.yml';
            if (fs.existsSync(cfBin) && fs.existsSync(cfCfg)) {
                const cf = spawn(cfBin, ['--config', cfCfg, 'tunnel', 'run', 'memorypassport_mac'], {
                    stdio: 'ignore',
                    detached: true
                });
                cf.unref();
                console.log('🌐 https://minji.memorypassport.kr 전용 터널 자동 시작 완료!');
            }
        }
    });
}

function runAppleScript(script) {
    return new Promise((resolve) => {
        if (!IS_MAC) return resolve('');
        execFile('/usr/bin/osascript', ['-e', script], { timeout: 4000 }, (err, stdout) => {
            if (err) return resolve('');
            resolve((stdout || '').trim());
        });
    });
}

function runHid(args) {
    return new Promise((resolve) => {
        if (!IS_MAC || !fs.existsSync(HID_BIN)) return resolve('');
        execFile(HID_BIN, args.map(String), { timeout: 3000 }, (err, stdout) => {
            if (err) return resolve('');
            resolve((stdout || '').trim());
        });
    });
}

// macOS Chrome 활성 탭의 실제 웹 뷰포트 (x, y, w, h)를 AX API로 100% 정밀 추출
function getChromeExactWebRect() {
    return new Promise((resolve) => {
        if (!IS_MAC || !fs.existsSync(HID_BIN)) return resolve(null);
        execFile(HID_BIN, ['get_chrome_rect'], { timeout: 1500 }, (err, stdout) => {
            if (err || !stdout) return resolve(null);
            const parts = stdout.trim().split(',').map(n => parseInt(n, 10));
            if (parts.length === 4 && parts[2] > 200 && parts[3] > 200) {
                return resolve({
                    left: parts[0],
                    top: parts[1],
                    width: parts[2],
                    height: parts[3]
                });
            }
            resolve(null);
        });
    });
}

// 크롬에서 공유 중인 미디어 탭(넷플릭스/티빙/쿠팡플레이/유튜브 등) 찾기 & 활성화 & 창 좌표 반환
async function focusAndGetMediaTab(navigateUrl = null) {
    const escapedUrl = navigateUrl ? navigateUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : '';
    const script = `
tell application "Google Chrome"
    set foundWin to missing value
    set foundTabIdx to 0
    set foundTab to missing value
    
    -- 1순위: 주요 OTT/영상 사이트 탭 탐색
    repeat with w in windows
        set tIdx to 1
        repeat with t in tabs of w
            set u to URL of t
            if (u contains "tving.com") or (u contains "netflix.com") or (u contains "coupangplay.com") or (u contains "wavve.com") or (u contains "disneyplus.com") or (u contains "watcha.com") or (u contains "youtube.com/watch") or (u contains "youtube.com/results") or (u = "https://www.youtube.com/") then
                set foundWin to w
                set foundTabIdx to tIdx
                set foundTab to t
                exit repeat
            end if
            set tIdx to tIdx + 1
        end repeat
        if foundWin is not missing value then exit repeat
    end repeat
    
    -- 2순위: 프라이빗 영화관/관리 페이지가 아닌 일반 탭 탐색
    if foundWin is missing value then
        repeat with w in windows
            set tIdx to 1
            repeat with t in tabs of w
                set u to URL of t
                if (u does not contain "memorypassport.kr") and (u does not contain "catchballstock.com") and (u does not contain "trycloudflare.com") and (u does not contain "localhost:3000") and (u does not contain "127.0.0.1:3000") and (u does not contain "render.com") and (u does not contain "github.com") and (u does not contain "studio.youtube.com") then
                    set foundWin to w
                    set foundTabIdx to tIdx
                    set foundTab to t
                    exit repeat
                end if
                set tIdx to tIdx + 1
            end repeat
            if foundWin is not missing value then exit repeat
        end repeat
    end if
    
    if foundWin is not missing value then
        if active tab index of foundWin is not foundTabIdx then
            set active tab index of foundWin to foundTabIdx
        end if
        ${escapedUrl ? `set URL of foundTab to "${escapedUrl}"` : ''}
        set index of foundWin to 1
        activate
        set b to bounds of foundWin
        return (item 1 of b as string) & "|" & (item 2 of b as string) & "|" & (item 3 of b as string) & "|" & (item 4 of b as string) & "|" & (title of foundTab) & "|" & (URL of foundTab)
    end if
end tell
`;
    const out = await runAppleScript(script);
    if (!out || !out.includes('|')) return null;
    const parts = out.split('|');
    return {
        left: parseInt(parts[0], 10) || 0,
        top: parseInt(parts[1], 10) || 33,
        right: parseInt(parts[2], 10) || 1280,
        bottom: parseInt(parts[3], 10) || 900,
        title: parts[4] || '',
        url: parts[5] || ''
    };
}

async function calcScreenCoords(winBounds, normX, normY, cmd = {}) {
    const x = Math.max(0.01, Math.min(0.99, Number(normX) || 0.5));
    const y = Math.max(0.01, Math.min(0.99, Number(normY) || 0.5));

    // 전체 화면(monitor) 공유인 경우
    if (cmd.displaySurface === 'monitor' && cmd.screenW && cmd.screenH) {
        return {
            screenX: Math.round(x * cmd.screenW),
            screenY: Math.round(y * cmd.screenH)
        };
    }

    // 1순위: Accessibility API(AX)를 통한 실제 크롬 웹 뷰포트 100% 정밀 좌표
    try {
        const exactRect = await getChromeExactWebRect();
        if (exactRect && exactRect.width > 200 && exactRect.height > 200) {
            return {
                screenX: Math.round(exactRect.left + x * exactRect.width),
                screenY: Math.round(exactRect.top + y * exactRect.height)
            };
        }
    } catch (_) {}

    // 2순위 (fallback): 창 경계 기반 뷰포트 추정 (실제 크롬 상단바 140px 보정)
    const winWidth = Math.max(300, winBounds.right - winBounds.left);
    const winHeight = Math.max(300, winBounds.bottom - winBounds.top);
    const aspect = Number(cmd.aspect) > 0.3 ? Number(cmd.aspect) : (16 / 9);

    const estimatedViewportH = Math.round(winWidth / aspect);
    const viewportHeight = Math.max(200, Math.min(winHeight - 140, estimatedViewportH));
    const viewportTop = winBounds.bottom - viewportHeight;

    return {
        screenX: Math.round(winBounds.left + x * winWidth),
        screenY: Math.round(viewportTop + y * viewportHeight)
    };
}

async function executeMacCommand(cmd) {
    if (!IS_MAC || !cmd) return;
    const cmdId = cmd.id || `${cmd.action}-${Date.now()}`;
    if (executedCommandIds.has(cmdId)) return;
    executedCommandIds.add(cmdId);
    if (executedCommandIds.size > 500) {
        const first = executedCommandIds.values().next().value;
        executedCommandIds.delete(first);
    }

    try {
        console.log(`🎮 [민지 리모컨 실행] action=${cmd.action}`, cmd.url || cmd.query || cmd.key || `(${cmd.x?.toFixed?.(2)}, ${cmd.y?.toFixed?.(2)})`);

        if (cmd.action === 'url' && cmd.url) {
            await focusAndGetMediaTab(cmd.url);
            return;
        }

        if (cmd.action === 'search' && cmd.query) {
            const q = encodeURIComponent(cmd.query.trim());
            let targetUrl = `https://www.tving.com/search?keyword=${q}`;
            if (cmd.platform === 'netflix') {
                targetUrl = `https://www.netflix.com/search?q=${q}`;
            } else if (cmd.platform === 'youtube') {
                targetUrl = `https://www.youtube.com/results?search_query=${q}`;
            }
            await focusAndGetMediaTab(targetUrl);
            return;
        }

        if (cmd.action === 'save-current-favorite') {
            const info = await focusAndGetMediaTab(null);
            if (info && info.url) {
                let platform = 'WEB';
                let icon = '⭐';
                if (info.url.includes('tving.com')) { platform = 'TVING'; icon = '💗'; }
                else if (info.url.includes('netflix.com')) { platform = 'NETFLIX'; icon = '🔴'; }
                else if (info.url.includes('coupangplay.com')) { platform = 'COUPANG'; icon = '💙'; }
                else if (info.url.includes('youtube.com')) { platform = 'YOUTUBE'; icon = '▶️'; }

                const customTitle = (cmd.customTitle || '').trim() || info.title.replace(/ - Chrome$/, '').trim() || '저장한 콘텐츠';
                const newFav = {
                    id: 'fav-' + Date.now(),
                    title: customTitle.slice(0, 28),
                    icon,
                    platform,
                    url: info.url
                };
                favoritesList.unshift(newFav);
                saveFavorites(favoritesList);
                io.emit('favorites-updated', favoritesList);
            }
            return;
        }

        const winBounds = await focusAndGetMediaTab(null);
        if (!winBounds) return;

        if (cmd.action === 'click') {
            const { screenX, screenY } = await calcScreenCoords(winBounds, cmd.x, cmd.y, cmd);
            await runHid(['click', screenX, screenY]);
        } else if (cmd.action === 'move') {
            const { screenX, screenY } = await calcScreenCoords(winBounds, cmd.x, cmd.y, cmd);
            await runHid(['move', screenX, screenY]);
        } else if (cmd.action === 'scroll') {
            const { screenX, screenY } = await calcScreenCoords(winBounds, cmd.x ?? 0.5, cmd.y ?? 0.5, cmd);
            const dy = parseInt(cmd.dy, 10) || -360;
            await runHid(['scroll', dy, screenX, screenY]);
        } else if (cmd.action === 'next-episode') {
            // 넷플릭스 / 티빙 전용: 다음 화 버튼 스마트 클릭 (우측 하단 다음화 버튼 영역 정밀 타격 또는 단축키)
            const exactRect = await getChromeExactWebRect();
            if (exactRect) {
                // 넷플릭스 플레이어 다음화 버튼 위치: 우측 하단 (x: 88~92%, y: 92%)
                const btnX = Math.round(exactRect.left + exactRect.width * 0.90);
                const btnY = Math.round(exactRect.top + exactRect.height * 0.92);
                await runHid(['click', btnX, btnY]);
            } else {
                const { screenX, screenY } = await calcScreenCoords(winBounds, 0.90, 0.92, cmd);
                await runHid(['click', screenX, screenY]);
            }
        } else if (cmd.action === 'key') {
            const keyMap = {
                space: 49,
                left: 123,
                right: 124,
                up: 126,
                down: 125,
                enter: 36,
                esc: 53,
                f: 3,
                s: 1, // 넷플릭스 오프닝 건너뛰기 단축키 'S'
                n: 45 // 넷플릭스 다음 화 단축키 'N'
            };
            const code = keyMap[cmd.key] ?? 49;
            await runHid(['key', code]);
        } else if (cmd.action === 'nav') {
            // macOS Chrome 뒤로가기: Cmd + [ (keycode 33), 앞으로가기: Cmd + ] (keycode 30)
            const code = cmd.dir === 'forward' ? 30 : 33;
            await runHid(['cmdkey', code]);
        }
    } catch (e) {
        console.error('executeMacCommand error:', e.message);
    }
}

// ====================================================
// REST API (리모컨 브릿지 & 즐겨찾기 관리)
// ====================================================
app.get('/api/favorites', (req, res) => {
    res.json(favoritesList);
});

app.post('/api/favorites', (req, res) => {
    const { title, url, platform, icon } = req.body || {};
    if (!title || !url) return res.status(400).json({ error: 'title and url required' });
    const newFav = {
        id: 'fav-' + Date.now(),
        title: String(title).trim().slice(0, 30),
        url: String(url).trim(),
        platform: platform || 'CUSTOM',
        icon: icon || '⭐'
    };
    favoritesList.unshift(newFav);
    saveFavorites(favoritesList);
    io.emit('favorites-updated', favoritesList);
    res.json({ ok: true, favorites: favoritesList });
});

app.delete('/api/favorites/:id', (req, res) => {
    const targetId = req.params.id;
    favoritesList = favoritesList.filter(item => item.id !== targetId);
    saveFavorites(favoritesList);
    io.emit('favorites-updated', favoritesList);
    res.json({ ok: true, favorites: favoritesList });
});

app.post('/api/remote', async (req, res) => {
    const cmd = req.body || {};
    if (!cmd.id) cmd.id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    enqueueRemoteCommand(cmd);
    if (IS_MAC) {
        await executeMacCommand(cmd);
    }
    res.json({ ok: true, executedOnMac: IS_MAC });
});

app.get('/api/remote-poll', (req, res) => {
    const since = parseInt(req.query.since, 10) || 0;
    const items = remoteCommandQueue.filter(item => item.ts > since);
    res.json({ commands: items, now: Date.now() });
});

// 맥북에서 실행 중일 때 클라우드 서버(https://movie.memorypassport.kr)와 실시간 WebSocket + 폴링 브릿지 연결
if (IS_MAC) {
    let lastCloudPollTs = Date.now();
    const CLOUD_THEATER_URL = process.env.CLOUD_THEATER_URL || 'https://movie.memorypassport.kr';

    // 1) 실시간 Socket.IO WebSocket 브릿지 (지연시간 < 20ms)
    function connectCloudSocketBridge() {
        try {
            const WebSocket = require('ws');
            const wsUrl = CLOUD_THEATER_URL.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
            const ws = new WebSocket(wsUrl);

            ws.on('message', async (raw) => {
                const msg = String(raw);
                if (msg.startsWith('0')) {
                    ws.send('40');
                } else if (msg.startsWith('40')) {
                    ws.send('42["join-room","movie-room"]');
                    console.log('🌐 클라우드 영화관(movie.memorypassport.kr) 실시간 리모컨 브릿지 연결 완료!');
                } else if (msg === '2') {
                    ws.send('3');
                } else if (msg.startsWith('42')) {
                    try {
                        const arr = JSON.parse(msg.slice(2));
                        if (arr[0] === 'room-event' && arr[1]?.type === 'remote-control' && arr[1]?.data) {
                            await executeMacCommand(arr[1].data);
                        }
                    } catch (_) {}
                }
            });

            ws.on('close', () => {
                setTimeout(connectCloudSocketBridge, 4000);
            });
            ws.on('error', () => {});
        } catch (e) {
            console.error('Cloud WS bridge error:', e.message);
        }
    }
    connectCloudSocketBridge();

    // 2) 백업 HTTP 폴링 브릿지
    setInterval(() => {
        const url = `${CLOUD_THEATER_URL}/api/remote-poll?since=${lastCloudPollTs}`;
        https.get(url, { timeout: 2500 }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return;
            }
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (Array.isArray(data.commands) && data.commands.length > 0) {
                        for (const cmd of data.commands) {
                            if (cmd.ts > lastCloudPollTs) lastCloudPollTs = cmd.ts;
                            await executeMacCommand(cmd);
                        }
                    }
                } catch (_) {}
            });
        }).on('error', () => {});
    }, 800);
}

// ====================================================
// Socket.IO 시그널링 및 실시간 이벤트 릴레이
// ====================================================
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 접속 시 현재 즐겨찾기 목록 전송
    socket.emit('favorites-updated', favoritesList);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        socket.currentRoomId = roomId;
        console.log(`User ${socket.id} joined room ${roomId}`);
        socket.to(roomId).emit('user-connected', socket.id);
    });

    // 민지가 재접속하거나 화면 재연결 버튼을 누를 때 호스트에게 즉시 새 WebRTC Offer 요청
    socket.on('request-stream', (roomId) => {
        const targetRoom = roomId || socket.currentRoomId;
        if (targetRoom) {
            console.log(`Stream re-requested by ${socket.id} in room ${targetRoom}`);
            socket.to(targetRoom).emit('user-connected', socket.id);
        }
    });

    socket.on('offer', (payload) => {
        io.to(payload.target).emit('offer', payload);
    });

    socket.on('answer', (payload) => {
        io.to(payload.target).emit('answer', payload);
    });

    socket.on('ice-candidate', (incoming) => {
        io.to(incoming.target).emit('ice-candidate', {
            candidate: incoming.candidate,
            sender: socket.id
        });
    });

    // 채팅, 이모티콘, 레이저, SOS, 원격 리모컨(remote-control), 즐겨찾기 추가 등 통합 릴레이
    socket.on('room-event', async (payload) => {
        if (!payload) return;

        if (payload.type === 'remote-control' && payload.data) {
            const cmd = {
                ...payload.data,
                id: payload.data.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                ts: Date.now()
            };
            payload.data = cmd;
            enqueueRemoteCommand(cmd);
            if (IS_MAC) {
                executeMacCommand(cmd);
            }
        } else if (payload.type === 'add-favorite' && payload.data) {
            const { title, url, platform, icon } = payload.data;
            if (title && url) {
                const newFav = {
                    id: 'fav-' + Date.now(),
                    title: String(title).trim().slice(0, 30),
                    url: String(url).trim(),
                    platform: platform || 'CUSTOM',
                    icon: icon || '⭐'
                };
                favoritesList.unshift(newFav);
                saveFavorites(favoritesList);
                io.emit('favorites-updated', favoritesList);
            }
        } else if (payload.type === 'delete-favorite' && payload.data?.id) {
            favoritesList = favoritesList.filter(item => item.id !== payload.data.id);
            saveFavorites(favoritesList);
            io.emit('favorites-updated', favoritesList);
        }

        if (payload.roomId) {
            socket.to(payload.roomId).emit('room-event', payload);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, "0.0.0.0", () => {
    console.log(`🎬 Movie theater server is running on http://localhost:${PORT}`);
});
