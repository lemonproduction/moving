const socket = io();

const hostBtn = document.getElementById('hostBtn');
const joinBtn = document.getElementById('joinBtn');
const minjiSoloBtn = document.getElementById('minjiSoloBtn');
const roomInput = document.getElementById('roomInput');
const videoPlayer = document.getElementById('videoPlayer'); // 메인 영화 화면
const localCam = document.getElementById('localCam');       // 내 얼굴
const remoteCam = document.getElementById('remoteCam');     // 상대 얼굴
const localCamBox = document.getElementById('localCamBox');
const remoteCamBox = document.getElementById('remoteCamBox');
const statusDiv = document.getElementById('status');
const voiceVolInput = document.getElementById('voiceVol');
const volLabel = document.getElementById('volLabel');

let screenStream;
let webcamStream;
let roomId;
let isHost = false;
let isSoloMode = false;
let touchControlEnabled = true;
let hostDisplaySurface = 'browser';

// 오디오 증폭 및 믹서 전역 변수
let remoteAudioCtx;
let remoteGainNode;
let movieGainNode;

function showRemoteToast(msg, duration = 2200) {
    const toast = document.getElementById('remoteToast');
    if (!toast) return;
    toast.innerText = msg;
    toast.classList.add('show');
    clearTimeout(window.remoteToastTimer);
    window.remoteToastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

window.changeVol = function(val) {
    const numVal = parseFloat(val) || 1;
    if (volLabel) volLabel.innerText = numVal + 'x';

    if (isSoloMode) {
        // 민지 전용 솔로 모드: 슬라이더가 영화 볼륨을 직접 조절 (기본 100%, 최대 400% 증폭)
        if (window.movieGainNode) {
            window.movieGainNode.gain.value = numVal;
        }
        if (videoPlayer && numVal <= 1) {
            videoPlayer.volume = numVal;
        }
    } else {
        // 같이 보기 모드: 상대방 음성 증폭 + 영화 소리도 자연스럽게 조절
        if (window.remoteGainNode) {
            window.remoteGainNode.gain.value = numVal * 2.5;
        }
        if (window.movieGainNode) {
            window.movieGainNode.gain.value = Math.min(1.5, 0.25 * numVal);
        }
        if (remoteCam && numVal <= 1) {
            remoteCam.volume = numVal;
        }
    }
};

function initAudioBooster() {
    if (!window.remoteAudioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        window.remoteAudioCtx = new AudioContext();
        
        // 1. 게스트 음성 증폭기 (기본 2.5배 펌핑)
        window.remoteGainNode = window.remoteAudioCtx.createGain();
        window.remoteGainNode.connect(window.remoteAudioCtx.destination);
        const vol = voiceVolInput ? parseFloat(voiceVolInput.value) : 1;
        window.remoteGainNode.gain.value = vol * 2.5;

        // 2. 영화 오디오 게인 노드 (솔로 모드일 때는 1.0 원음, 같이 보기일 때는 음성 대화를 위해 0.25)
        window.movieGainNode = window.remoteAudioCtx.createGain();
        window.movieGainNode.connect(window.remoteAudioCtx.destination);
        window.movieGainNode.gain.value = isSoloMode ? 1.0 : 0.25;
    } else {
        if (window.movieGainNode) {
            const vol = voiceVolInput ? parseFloat(voiceVolInput.value) : 1;
            window.movieGainNode.gain.value = isSoloMode ? vol : (0.25 * vol);
        }
    }
    if (window.remoteAudioCtx.state === 'suspended') {
        window.remoteAudioCtx.resume();
    }
}

// 호스트 탭이 백그라운드에 있어도 크롬이 절전(Freeze/Throttle)하지 않도록 무음 오디오 유지
function keepHostTabAwake() {
    try {
        initAudioBooster();
        const ctx = window.remoteAudioCtx;
        if (!ctx || window._hostKeepAliveOsc) return;
        const osc = ctx.createOscillator();
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0.00001;
        osc.connect(silentGain);
        silentGain.connect(ctx.destination);
        osc.start();
        window._hostKeepAliveOsc = osc;
    } catch (e) {
        console.warn('keepHostTabAwake warning:', e);
    }
}

// 화면 터치 시 Safari AudioContext & 비디오 자동 활성화 보장
function ensurePlaybackActive() {
    if (window.remoteAudioCtx && window.remoteAudioCtx.state === 'suspended') {
        window.remoteAudioCtx.resume();
    }
    if (!isHost && videoPlayer && videoPlayer.srcObject && videoPlayer.paused) {
        videoPlayer.play().catch(() => {});
    }
}
document.addEventListener('touchstart', ensurePlaybackActive, { passive: true });
document.addEventListener('click', ensurePlaybackActive);

// 모바일에서 카톡 등 다른 앱을 보다가 돌아왔을 때 자동 재생 복구 및 끊김 시 재연결
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !isHost && roomId) {
        ensurePlaybackActive();
        const hasActiveStream = videoPlayer.srcObject && videoPlayer.srcObject.active;
        if (!hasActiveStream) {
            window.reconnectStream(true);
        }
    }
});

function applyAudioBooster(stream) {
    if (!window.remoteAudioCtx || !window.remoteGainNode) return;
    
    const remoteCam = document.getElementById('remoteCam');
    remoteCam.muted = true; // 중복 에코 방지
    
    if (!stream.boostConnected && stream.getAudioTracks().length > 0) {
        try {
            const audioStream = new MediaStream([stream.getAudioTracks()[0]]);
            const source = window.remoteAudioCtx.createMediaStreamSource(audioStream);
            source.connect(window.remoteGainNode);
            stream.boostConnected = true;
        } catch (e) {
            console.error("Voice Audio Booster Error:", e);
            remoteCam.muted = false; // 에러나면 기본 소리라도 나게 켬
        }
    }
}

function applyMovieAudio(stream) {
    if (!window.remoteAudioCtx || !window.movieGainNode) return;
    
    videoPlayer.muted = true;
    const vol = voiceVolInput ? parseFloat(voiceVolInput.value) : 1;
    window.movieGainNode.gain.value = isSoloMode ? vol : (0.25 * vol);
    
    if (!stream.movieBoostConnected && stream.getAudioTracks().length > 0) {
        try {
            const audioStream = new MediaStream([stream.getAudioTracks()[0]]);
            const source = window.remoteAudioCtx.createMediaStreamSource(audioStream);
            source.connect(window.movieGainNode);
            stream.movieBoostConnected = true;
            console.log(`🎬 영화 오디오 믹서 연결 완료 (솔로모드=${isSoloMode}, 볼륨=${window.movieGainNode.gain.value})`);
        } catch (e) {
            console.error("Movie Audio Booster Error:", e);
            videoPlayer.muted = false;
        }
    } else if (stream.getAudioTracks().length === 0) {
        videoPlayer.muted = false;
    }
}

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// 1. 방 만들기 (맥북 호스트)
hostBtn.addEventListener('click', async () => {
    isSoloMode = false;
    initAudioBooster();
    roomId = roomInput.value.trim();
    if (!roomId) return alert("방 이름을 입력하세요.");

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { cursor: "always", frameRate: 30, height: { ideal: 720 } },
            audio: {
                autoGainControl: false,
                echoCancellation: false,
                noiseSuppression: false
            }
        });

        const vTrack = screenStream.getVideoTracks()[0];
        if (vTrack && vTrack.getSettings) {
            const settings = vTrack.getSettings();
            if (settings.displaySurface) {
                hostDisplaySurface = settings.displaySurface;
            }
        }
        
        videoPlayer.srcObject = screenStream;
        videoPlayer.muted = true;
        
        webcamStream = null;
        localCamBox.style.display = 'none'; 
        remoteCamBox.style.display = 'none';
        
        isHost = true;
        keepHostTabAwake();
        socket.emit('join-room', roomId);
        
        statusDiv.innerText = `호스트 모드: [${roomId}] 방에 입장했습니다. 민지님이 언제든 접속해 원격으로 시청할 수 있습니다.`;
        disableInputs();
        showFeatures();
        showRemoteToast('💻 맥북 호스트 준비 완료! 외출하셔도 민지님이 원격으로 조작할 수 있습니다.', 4000);
    } catch (err) {
        console.error("Error sharing media: ", err);
        alert("화면 공유 권한이 필요합니다. (티빙/넷플릭스 크롬 탭과 '탭 오디오 공유'를 선택해주세요)");
    }
});

// 2. 💖 민지 전용 원클릭 입장 (카메라/마이크 없이 바로 입장 + 원격 리모컨 활성화)
async function startMinjiSoloMode() {
    isSoloMode = true;
    isHost = false;
    touchControlEnabled = true;
    if (voiceVolInput) voiceVolInput.value = '1.2';
    if (volLabel) volLabel.innerText = '1.2x';

    initAudioBooster();
    roomId = roomInput.value.trim() || 'movie-room';

    webcamStream = null;
    localCamBox.style.display = 'none';
    remoteCamBox.style.display = 'none';

    socket.emit('join-room', roomId);
    statusDiv.innerText = `민지 전용 모드: [${roomId}] 입장 중...`;
    disableInputs();
    showFeatures();
    updateTouchModeUI();
    showRemoteToast('💖 민지 전용 영화관 입장! 화면을 직접 터치하거나 아래 [리모컨]을 눌러보세요.', 4200);

    // 만약 2.5초 내에 스트림이 안 오면 자동으로 호스트에 스트림 재요청
    setTimeout(() => {
        if (!videoPlayer.srcObject) {
            socket.emit('request-stream', roomId);
        }
    }, 2500);
}

if (minjiSoloBtn) {
    minjiSoloBtn.addEventListener('click', startMinjiSoloMode);
}

// 3. 같이 보기 방 참여 (카메라/마이크 ON)
joinBtn.addEventListener('click', async () => {
    isSoloMode = false;
    initAudioBooster();
    roomId = roomInput.value.trim();
    if (!roomId) return alert("방 이름을 입력하세요.");

    try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
            audio: {
                autoGainControl: false,
                noiseSuppression: false
            }
        });
        
        localCam.srcObject = webcamStream;
        localCamBox.style.display = 'block';
        remoteCamBox.style.display = 'block';

        isHost = false;
        socket.emit('join-room', roomId);
        
        statusDiv.innerText = `게스트 모드: [${roomId}] 방에 입장했습니다. 연결 대기 중...`;
        disableInputs();
        showFeatures();
        updateTouchModeUI();
    } catch(err) {
        console.error("Error accessing camera: ", err);
        if (confirm("카메라/마이크 권한 없이 '민지 전용 모드(혼자 편하게 보기)'로 바로 입장할까요?")) {
            startMinjiSoloMode();
        }
    }
});

// URL 파라미터 (?mode=minji 또는 ?solo=1)로 접속 시 원클릭 안내
window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('room')) {
        roomInput.value = params.get('room');
    }
    loadFavoritesFromServer();
});

// ==========================================
// WebRTC 피어 연결 및 무제한 자동 재연결
// ==========================================
const peers = {}; // userId -> RTCPeerConnection

socket.on('user-connected', async (userId) => {
    console.log('User connected:', userId);
    statusDiv.innerText = `새로운 참가자가 입장했습니다! 연결 중...`;

    // 기존에 남아있던 연결이 있으면 정리 후 새 연결 생성
    if (peers[userId]) {
        try { peers[userId].close(); } catch (_) {}
        delete peers[userId];
    }
    
    const pc = createPeerConnection(userId);
    const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
    });
    await pc.setLocalDescription(offer);
    
    socket.emit('offer', {
        target: userId,
        caller: socket.id,
        sdp: pc.localDescription,
        isHost: isHost
    });
});

socket.on('offer', async (payload) => {
    if (payload.isHost) {
        window.hostSocketId = payload.caller;
    }

    if (peers[payload.caller]) {
        try { peers[payload.caller].close(); } catch (_) {}
        delete peers[payload.caller];
    }
    
    const pc = createPeerConnection(payload.caller);
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socket.emit('answer', {
        target: payload.caller,
        caller: socket.id,
        sdp: pc.localDescription
    });
});

socket.on('answer', async (payload) => {
    const pc = peers[payload.caller];
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        statusDiv.innerText = `성공적으로 연결되었습니다! 즐거운 관람 되세요 🍿`;
    }
});

socket.on('ice-candidate', async (incoming) => {
    const pc = peers[incoming.sender];
    if (pc && incoming.candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(incoming.candidate));
        } catch (e) {
            console.error('Error adding received ice candidate', e);
        }
    }
});

function createPeerConnection(targetUserId) {
    const pc = new RTCPeerConnection(configuration);
    peers[targetUserId] = pc;

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: targetUserId,
                candidate: event.candidate
            });
        }
    };

    pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (!stream) return;
        
        if (!isHost) {
            // 호스트가 보낸 영화 스트림이거나 솔로 모드인 경우 메인 스크린에 연결
            if (targetUserId === window.hostSocketId || isSoloMode || !videoPlayer.srcObject) {
                if (videoPlayer.srcObject !== stream) {
                    videoPlayer.srcObject = stream;
                    applyMovieAudio(stream);
                    videoPlayer.play().catch(() => {});
                    statusDiv.innerText = `영화 스트리밍 수신 중 🍿`;
                }
            } else {
                if (remoteCam.srcObject !== stream) {
                    remoteCam.srcObject = stream; 
                    applyAudioBooster(stream);
                }
            }
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            delete peers[targetUserId];
            // 게스트인데 호스트와의 연결이 끊겼다면 2초 후 자동 재요청
            if (!isHost && targetUserId === window.hostSocketId && roomId) {
                setTimeout(() => {
                    socket.emit('request-stream', roomId);
                }, 2000);
            }
        }
    };

    if (screenStream) {
        screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
    }
    if (webcamStream) {
        webcamStream.getTracks().forEach(track => pc.addTrack(track, webcamStream));
    }

    return pc;
}

window.reconnectStream = function(silent = false) {
    if (!roomId || isHost) return;
    if (!silent) showRemoteToast('🔄 맥북 호스트 화면을 다시 연결하는 중...');
    ensurePlaybackActive();
    socket.emit('request-stream', roomId);
};

function disableInputs() {
    hostBtn.disabled = true;
    joinBtn.disabled = true;
    if (minjiSoloBtn) minjiSoloBtn.disabled = true;
    roomInput.disabled = true;
}

// ==========================================
// 🎮 민지 전용 원격 제어 (화면 직접 터치 + 스와이프 + 스마트 리모컨)
// ==========================================

function getStreamAspect() {
    if (videoPlayer && videoPlayer.videoWidth && videoPlayer.videoHeight) {
        return videoPlayer.videoWidth / videoPlayer.videoHeight;
    }
    return 16 / 9;
}

// object-fit: contain 레터박스(검은 여백)를 제외한 실제 영상 내부의 (0.0 ~ 1.0) 정규화 좌표 계산
function getNormalizedVideoCoords(clientX, clientY) {
    if (!videoPlayer) return null;
    const rect = videoPlayer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const vw = videoPlayer.videoWidth || 1280;
    const vh = videoPlayer.videoHeight || 720;
    const videoRatio = vw / vh;
    const elemRatio = rect.width / rect.height;

    let renderW, renderH, offsetX, offsetY;
    if (elemRatio > videoRatio) {
        renderH = rect.height;
        renderW = renderH * videoRatio;
        offsetX = rect.left + (rect.width - renderW) / 2;
        offsetY = rect.top;
    } else {
        renderW = rect.width;
        renderH = renderW / videoRatio;
        offsetX = rect.left;
        offsetY = rect.top + (rect.height - renderH) / 2;
    }

    const normX = (clientX - offsetX) / renderW;
    const normY = (clientY - offsetY) / renderH;

    if (normX < 0 || normX > 1 || normY < 0 || normY > 1) {
        return null;
    }
    return { x: normX, y: normY };
}

function spawnTouchRipple(clientX, clientY) {
    const ripple = document.createElement('div');
    ripple.className = 'touch-ripple';
    ripple.style.left = clientX + 'px';
    ripple.style.top = clientY + 'px';
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
}

// 원격 제어 명령 전송 (Socket.IO + 직접 API 호출 이중화)
function dispatchRemoteControl(cmdData) {
    const payloadData = {
        ...cmdData,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        aspect: getStreamAspect()
    };

    if (roomId) {
        socket.emit('room-event', {
            roomId,
            type: 'remote-control',
            data: payloadData
        });
    }

    // 현재 서버에도 직접 POST (로컬 접속이거나 클라우드 큐 등록용)
    fetch('/api/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadData)
    }).catch(() => {});
}

// 호스트 브라우저(맥북)가 게스트의 원격 제어 이벤트를 받으면 로컬 맥북 데몬(127.0.0.1:3000)으로 즉시 전달
function forwardRemoteToLocalMac(cmdData) {
    const enriched = {
        ...cmdData,
        displaySurface: hostDisplaySurface || 'browser',
        screenW: window.screen.width,
        screenH: window.screen.height,
        aspect: getStreamAspect()
    };
    fetch('http://127.0.0.1:3000/api/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(enriched)
    }).catch(() => {});
}

// 비디오 화면 직접 터치(클릭) & 위아래 드래그(스크롤) 이벤트 처리
let pointerDownInfo = null;

if (videoPlayer) {
    videoPlayer.addEventListener('pointerdown', (e) => {
        if (isHost || !touchControlEnabled) return;
        if (e.button !== undefined && e.button !== 0) return;

        // 리모컨 창이 열려있을 때 화면을 누르면 리모컨 창을 닫으면서 클릭 처리
        const drawer = document.getElementById('remoteDrawer');
        if (drawer && drawer.classList.contains('open')) {
            drawer.classList.remove('open');
        }

        const coords = getNormalizedVideoCoords(e.clientX, e.clientY);
        if (!coords) return;

        pointerDownInfo = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            lastY: e.clientY,
            normX: coords.x,
            normY: coords.y,
            scrolled: false
        };
        try { videoPlayer.setPointerCapture(e.pointerId); } catch (_) {}
    });

    videoPlayer.addEventListener('pointermove', (e) => {
        if (!pointerDownInfo || pointerDownInfo.pointerId !== e.pointerId) return;
        const deltaY = e.clientY - pointerDownInfo.lastY;
        const totalDist = Math.hypot(e.clientX - pointerDownInfo.startX, e.clientY - pointerDownInfo.startY);

        // 35px 이상 위/아래로 스와이프하면 자연스러운 원격 스크롤 실행
        if (Math.abs(deltaY) >= 36 && totalDist > 24) {
            pointerDownInfo.scrolled = true;
            pointerDownInfo.lastY = e.clientY;
            // 손가락을 위로 올리면(deltaY < 0) 화면을 아래로 스크롤(음수 dy)
            const scrollDy = Math.max(-700, Math.min(700, Math.round(deltaY * 2.2)));
            dispatchRemoteControl({
                action: 'scroll',
                dy: scrollDy,
                x: pointerDownInfo.normX,
                y: pointerDownInfo.normY
            });
        }
    });

    videoPlayer.addEventListener('pointerup', (e) => {
        if (!pointerDownInfo || pointerDownInfo.pointerId !== e.pointerId) return;
        const totalDist = Math.hypot(e.clientX - pointerDownInfo.startX, e.clientY - pointerDownInfo.startY);

        if (!pointerDownInfo.scrolled && totalDist < 16) {
            const coords = getNormalizedVideoCoords(e.clientX, e.clientY) || {
                x: pointerDownInfo.normX,
                y: pointerDownInfo.normY
            };
            spawnTouchRipple(e.clientX, e.clientY);
            dispatchRemoteControl({
                action: 'click',
                x: coords.x,
                y: coords.y
            });
        }
        pointerDownInfo = null;
    });

    videoPlayer.addEventListener('pointercancel', () => {
        pointerDownInfo = null;
    });

    // PC 마우스 휠로도 원격 스크롤 가능
    videoPlayer.addEventListener('wheel', (e) => {
        if (isHost || !touchControlEnabled) return;
        const now = Date.now();
        if (now - (window._lastWheelSent || 0) < 120) return;
        window._lastWheelSent = now;
        const coords = getNormalizedVideoCoords(e.clientX, e.clientY) || { x: 0.5, y: 0.5 };
        dispatchRemoteControl({
            action: 'scroll',
            dy: e.deltaY > 0 ? -320 : 320,
            x: coords.x,
            y: coords.y
        });
    }, { passive: true });
}

// 리모컨 버튼 액션 함수들
window.toggleTouchControl = function() {
    touchControlEnabled = !touchControlEnabled;
    updateTouchModeUI();
    showRemoteToast(touchControlEnabled ? '👆 화면 직접 터치 조작이 켜졌습니다' : '🔒 화면 터치 잠금 (실수 터치 방지)');
};

function updateTouchModeUI() {
    const btn = document.getElementById('touchModeBtn');
    const txt = document.getElementById('touchModeText');
    if (!btn || !txt) return;
    if (touchControlEnabled) {
        btn.classList.add('active-touch');
        txt.innerText = '👆 터치조작 ON';
    } else {
        btn.classList.remove('active-touch');
        txt.innerText = '🔒 터치잠금';
    }
}

window.toggleRemoteDrawer = function() {
    const drawer = document.getElementById('remoteDrawer');
    if (!drawer) return;
    drawer.classList.toggle('open');
};

window.sendRemoteUrl = function(url, label) {
    if (!url) return;
    showRemoteToast(`🚀 ${label || '이동 중'}...`);
    dispatchRemoteControl({ action: 'url', url });
};

window.sendRemoteKey = function(key, label) {
    if (label) showRemoteToast(label);
    dispatchRemoteControl({ action: 'key', key });
};

window.sendRemoteScroll = function(dy, label) {
    if (label) showRemoteToast(label, 1200);
    dispatchRemoteControl({ action: 'scroll', dy, x: 0.5, y: 0.5 });
};

window.sendRemoteNav = function(dir) {
    showRemoteToast(dir === 'back' ? '🔙 이전 화면으로 돌아갑니다' : '🔜 다음 화면으로 이동합니다');
    dispatchRemoteControl({ action: 'nav', dir });
};

window.triggerRemoteSearch = function(platform) {
    const input = document.getElementById('remoteSearchInput');
    const query = input ? input.value.trim() : '';
    if (!query) {
        return alert('검색할 드라마, 예능, 영화 제목을 입력해주세요!');
    }
    const pName = platform === 'netflix' ? '넷플릭스' : '티빙';
    showRemoteToast(`🔍 ${pName}에서 [${query}] 검색 중...`, 2800);
    dispatchRemoteControl({ action: 'search', platform, query });
};

window.handleMainPlayPause = function() {
    if (isSoloMode) {
        sendRemoteKey('space', '⏯ 재생 / 일시정지');
    } else {
        sendRemoteKey('space', '⏯ 재생 / 일시정지');
    }
};

// ==========================================
// ⭐ 민지 전용 주크박스 (즐겨찾기 목록 렌더링 & 추가/삭제)
// ==========================================
let currentFavorites = [];

async function loadFavoritesFromServer() {
    try {
        const res = await fetch('/api/favorites');
        if (res.ok) {
            const list = await res.json();
            if (Array.isArray(list)) {
                currentFavorites = list;
                renderFavorites();
            }
        }
    } catch (_) {}
}

socket.on('favorites-updated', (list) => {
    if (Array.isArray(list)) {
        currentFavorites = list;
        renderFavorites();
    }
});

function renderFavorites() {
    const container = document.getElementById('favoritesContainer');
    if (!container) return;
    container.innerHTML = '';

    currentFavorites.forEach((item) => {
        const chip = document.createElement('div');
        chip.className = 'fav-chip';
        chip.onclick = () => {
            window.sendRemoteUrl(item.url, `${item.icon || '🎬'} ${item.title} 틀기`);
        };

        const labelSpan = document.createElement('span');
        labelSpan.innerText = `${item.icon || '⭐'} ${item.title}`;
        chip.appendChild(labelSpan);

        // 사용자가 추가한 커스텀 즐겨찾기는 삭제 버튼 표시
        if (String(item.id).startsWith('fav-')) {
            const delBtn = document.createElement('span');
            delBtn.className = 'del-fav';
            delBtn.innerText = '✕';
            delBtn.title = '삭제';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                deleteFavoriteItem(item.id);
            };
            chip.appendChild(delBtn);
        }

        container.appendChild(chip);
    });
}

window.saveCurrentTabFavorite = function() {
    const searchInput = document.getElementById('remoteSearchInput');
    const typedTitle = searchInput ? searchInput.value.trim() : '';
    const customTitle = prompt('즐겨찾기에 저장할 작품 이름을 입력하세요 (비워두면 현재 탭 제목으로 자동 저장됩니다):', typedTitle);
    if (customTitle === null) return; // 취소 클릭 시

    showRemoteToast('⭐ 현재 보고 있는 작품을 즐겨찾기에 저장했습니다!');
    dispatchRemoteControl({
        action: 'save-current-favorite',
        customTitle: customTitle.trim()
    });
};

function deleteFavoriteItem(id) {
    fetch(`/api/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    if (roomId) {
        socket.emit('room-event', { roomId, type: 'delete-favorite', data: { id } });
    }
}

// ==========================================
// 기존 기능 (채팅, 이모티콘, SOS, 레이저, 웹캠 확대)
// ==========================================

socket.on('room-event', (payload) => {
    if (!payload) return;
    if (payload.type === 'reaction') {
        showReactionBubble(payload.data);
    } else if (payload.type === 'chat') {
        appendChatMessage(payload.data, false);
    } else if (payload.type === 'sos') {
        document.getElementById('sosOverlay').style.display = 'flex';
    } else if (payload.type === 'remote-control' && payload.data) {
        // 호스트(맥북) 브라우저가 원격 명령을 수신하면 로컬 맥북 서버(127.0.0.1:3000)로 즉시 브릿지
        if (isHost) {
            forwardRemoteToLocalMac(payload.data);
        }
    } else if (payload.type === 'laser') {
        const laser = document.getElementById('laserPointer');
        if (laser) {
            laser.style.display = 'block';
            laser.style.left = (payload.data.x * window.innerWidth) + 'px';
            laser.style.top = (payload.data.y * window.innerHeight) + 'px';
            clearTimeout(window.laserTimer);
            window.laserTimer = setTimeout(() => { laser.style.display = 'none'; }, 2000);
        }
    }
});

// 2. 이모티콘 리액션
window.sendReaction = function(emoji) {
    if(!roomId) return;
    showReactionBubble(emoji);
    socket.emit('room-event', { roomId, type: 'reaction', data: emoji });
};
function showReactionBubble(emoji) {
    const container = document.getElementById('reactionContainer');
    const bubble = document.createElement('div');
    bubble.className = 'reaction-bubble';
    bubble.innerText = emoji;
    bubble.style.left = Math.random() * 60 + 'px';
    container.appendChild(bubble);
    setTimeout(() => bubble.remove(), 2500);
}

// 3. 실시간 틱톡(Ticker) 채팅
window.sendChat = function() {
    try {
        const input = document.getElementById('chatInput');
        const msg = input.value.trim();
        if (!msg) return; 
        
        if (typeof roomId === 'undefined' || !roomId) {
            appendChatMessage(msg, true);
        } else {
            appendChatMessage(msg, true);
            if (typeof socket !== 'undefined' && socket) {
                socket.emit('room-event', { roomId, type: 'chat', data: msg });
            }
        }
        
        input.value = '';
    } catch (e) {
        console.error(e);
        alert("채팅 전송 에러: " + e.message);
    }
};

function appendChatMessage(msg, isMe) {
    const container = document.getElementById('tickerContainer');
    if(!container) return;
    
    const div = document.createElement('div');
    div.innerText = msg;
    div.style.position = 'absolute';
    div.style.whiteSpace = 'nowrap';
    div.style.fontSize = isMe ? '1.8em' : '2em';
    div.style.color = isMe ? '#FFD700' : '#FFFFFF';
    let topOffset;
    if (window.innerHeight > window.innerWidth) {
        topOffset = Math.random() * 10 + 35; 
    } else {
        topOffset = Math.random() * 15 + 10;
    }
    div.style.top = topOffset + '%';
    div.style.left = '100vw'; 
    div.style.transform = 'translateX(0)';
    
    container.appendChild(div);
    window.getComputedStyle(div).transform;
    
    requestAnimationFrame(() => {
        div.style.webkitTransition = '-webkit-transform 6s linear';
        div.style.transition = 'transform 6s linear';
        div.style.webkitTransform = 'translateX(-150vw)';
        div.style.transform = 'translateX(-150vw)';
    });
    
    setTimeout(() => {
        if (div && div.parentNode) div.remove();
    }, 6500);
}

// 4. SOS 팝콘 타임
window.sendSOS = function() {
    if(!roomId) return;
    document.getElementById('sosOverlay').style.display = 'flex';
    socket.emit('room-event', { roomId, type: 'sos' });
};

// 7. 모던 UI 컨트롤
function showFeatures() {
    document.getElementById('lobbyContainer').style.display = 'none';
    document.getElementById('theaterContainer').style.display = 'flex';
}

let isChatOpen = false;
window.toggleChat = function() {
    isChatOpen = !isChatOpen;
    document.getElementById('chatInputWrapper').style.display = isChatOpen ? 'flex' : 'none';
    
    const toggleBtn = document.getElementById('chatToggleBtn');
    if(toggleBtn) {
        toggleBtn.style.background = isChatOpen ? '#E50914' : 'rgba(30, 30, 35, 0.8)';
    }
    
    if(isChatOpen) document.getElementById('chatInput').focus();
};

window.showFeatures = showFeatures;

// 8. 웹캠 클릭 시 확대 / 축소 (대화 중심 모드)
window.toggleCamExpand = function(el) {
    if (!el) return;
    document.querySelectorAll('.cam-box').forEach(box => {
        if (box !== el) box.classList.remove('expanded');
    });
    el.classList.toggle('expanded');
};
