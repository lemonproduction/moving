

const socket = io();

const hostBtn = document.getElementById('hostBtn');
const joinBtn = document.getElementById('joinBtn');
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

// 오디오 증폭기 전역 변수
let remoteAudioCtx;
let remoteGainNode;

window.changeVol = function(val) {
    document.getElementById('volLabel').innerText = val + 'x';
    if (window.remoteGainNode) {
        window.remoteGainNode.gain.value = parseFloat(val) * 1.4; // 기본 마이크 볼륨 40% 강제 펌핑
    }
    // Safari fallback: 혹시 WebAudio가 작동안하면 video 볼륨이라도 조절 (최대 1.0)
    const remoteCam = document.getElementById('remoteCam');
    if (remoteCam && val <= 1) {
        remoteCam.volume = val;
    }
};

function initAudioBooster() {
    if (!window.remoteAudioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        window.remoteAudioCtx = new AudioContext();
        window.remoteGainNode = window.remoteAudioCtx.createGain();
        window.remoteGainNode.connect(window.remoteAudioCtx.destination);
        
        const vol = document.getElementById('voiceVol').value;
        window.remoteGainNode.gain.value = parseFloat(vol) * 1.4; // 기본 마이크 볼륨 40% 강제 펌핑
    }
    if (window.remoteAudioCtx.state === 'suspended') {
        window.remoteAudioCtx.resume();
    }
}

function applyAudioBooster(stream) {
    if (!window.remoteAudioCtx || !window.remoteGainNode) return;
    
    const remoteCam = document.getElementById('remoteCam');
    remoteCam.muted = true; // 중복 에코 방지
    
    if (!stream.boostConnected && stream.getAudioTracks().length > 0) {
        try {
            // 새 MediaStream 객체로 감싸서 Safari 버그 우회 시도
            const audioStream = new MediaStream([stream.getAudioTracks()[0]]);
            const source = window.remoteAudioCtx.createMediaStreamSource(audioStream);
            source.connect(window.remoteGainNode);
            stream.boostConnected = true;
        } catch (e) {
            console.error("Audio Booster Error:", e);
            remoteCam.muted = false; // 에러나면 기본 소리라도 나게 켬
        }
    }
}

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// 방 만들기 (호스트)
hostBtn.addEventListener('click', async () => {
    initAudioBooster();
    roomId = roomInput.value.trim();
    if (!roomId) return alert("방 이름을 입력하세요.");

    try {
        // 1. 호스트(맥북): 영화 화면(오디오 포함)만 캡처 (웹캠 생략)
        screenStream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { cursor: "always", frameRate: 30, height: { ideal: 720 } },
            audio: true 
        });
        
        videoPlayer.srcObject = screenStream;
        videoPlayer.muted = true; // 본인은 영화 소리 뮤트
        
        // 호스트는 내 웹캠을 켜지 않음
        webcamStream = null;
        localCamBox.style.display = 'none'; 
        remoteCamBox.style.display = 'none';
        
        isHost = true;
        socket.emit('join-room', roomId);
        
        statusDiv.innerText = `호스트 모드: [${roomId}] 방에 입장했습니다. 민지님을 기다리는 중...`;
        disableInputs(); showFeatures();

    } catch (err) {
        console.error("Error sharing media: ", err);
        alert("화면 공유 또는 카메라 권한이 필요합니다.");
    }
});

// 방 참여 (게스트)
joinBtn.addEventListener('click', async () => {
    initAudioBooster();
    roomId = roomInput.value.trim();
    if (!roomId) return alert("방 이름을 입력하세요.");

    try {
        // 내 웹캠(얼굴+목소리) 캡처
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 240, frameRate: 15 },
            audio: true
        });
        
        localCam.srcObject = webcamStream;
        localCamBox.style.display = 'block'; remoteCamBox.style.display = 'block';

        isHost = false;
        socket.emit('join-room', roomId);
        
        statusDiv.innerText = `게스트 모드: [${roomId}] 방에 입장했습니다. 연결 대기 중...`;
        disableInputs(); showFeatures();
    } catch(err) {
        console.error("Error accessing camera: ", err);
        alert("카메라/마이크 권한이 필요합니다.");
    }
});

// 게스트 접속 시 (호스트에서만 실행됨)
const peers = {}; // userId -> RTCPeerConnection

socket.on('user-connected', async (userId) => {
    console.log('User connected:', userId);
    statusDiv.innerText = `새로운 참가자가 입장했습니다! 연결 중...`;
    
    const pc = createPeerConnection(userId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socket.emit('offer', {
        target: userId,
        caller: socket.id,
        sdp: pc.localDescription,
        screenStreamId: screenStream ? screenStream.id : null,
        webcamStreamId: webcamStream ? webcamStream.id : null
    });
});

socket.on('offer', async (payload) => {
    if (payload.screenStreamId) {
        window.hostScreenStreamId = payload.screenStreamId;
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
    if (pc) {
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
        
        if (isHost) {
            // 호스트(맥북)는 게스트들의 웹캠을 받을 수 있지만, 화면에 표시하지 않음 (서버 역할)
            // 원한다면 볼 수 있게 remoteCam.srcObject = stream 할 수 있으나 UI에서 숨겼음.
        } else {
            // 게스트(모바일)는 두 종류의 스트림을 받음: 호스트의 영화, 또는 다른 게스트의 웹캠
            if (stream.id === window.hostScreenStreamId) {
                if (videoPlayer.srcObject !== stream) {
                    videoPlayer.srcObject = stream;
                    statusDiv.innerText = `영화 스트리밍 수신 중 🍿`;
                }
            } else {
                // 다른 게스트의 웹캠!
                if (remoteCam.srcObject !== stream) {
                    remoteCam.srcObject = stream; 
                    applyAudioBooster(stream);
                }
            }
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            // 연결 끊김 처리 (해당 peer 삭제)
            delete peers[targetUserId];
        }
    };

    // 내가 가진 스트림들(영화 또는 내 웹캠)을 상대방에게 모두 전송
    if (screenStream) {
        screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
    }
    if (webcamStream) {
        webcamStream.getTracks().forEach(track => pc.addTrack(track, webcamStream));
    }

    return pc;
}

function disableInputs() {
    hostBtn.disabled = true;
    joinBtn.disabled = true;
    roomInput.disabled = true;
}

// ==========================================
// 추가 기능 구현 (채팅, 이모티콘, SOS, 레이저, 시네마 모드)
// ==========================================


// 1. 소켓 이벤트 수신
socket.on('room-event', (payload) => {
    if (payload.type === 'reaction') {
        showReactionBubble(payload.data);
    } else if (payload.type === 'chat') {
        appendChatMessage(payload.data, false);
    } else if (payload.type === 'sos') {
        document.getElementById('sosOverlay').style.display = 'flex';
    } else if (payload.type === 'laser') {
        const laser = document.getElementById('laserPointer');
        laser.style.display = 'block';
        laser.style.left = (payload.data.x * window.innerWidth) + 'px';
        laser.style.top = (payload.data.y * window.innerHeight) + 'px';
        
        clearTimeout(window.laserTimer);
        window.laserTimer = setTimeout(() => { laser.style.display = 'none'; }, 2000);
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
    bubble.style.left = Math.random() * 60 + 'px'; // 좌우 랜덤 위치
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
        // 세로 모드(모바일): 위아래 레터박스(검은 여백)가 크므로, 실제 영상이 있는 35%~45% 위치로 지정
        topOffset = Math.random() * 10 + 35; 
    } else {
        // 가로 모드(PC): 화면 전체를 쓰므로 10%~25% 위치로 지정
        topOffset = Math.random() * 15 + 10;
    }
    div.style.top = topOffset + '%'; // 영상 중앙을 가리지 않도록 화면 최상단(5~15%)에만 표시
    
    // 시작 위치 (화면 오른쪽 끝에 딱 붙어서 시작)
    div.style.left = '100vw'; 
    div.style.transform = 'translateX(0)';
    
    container.appendChild(div);
    
    // 브라우저 렌더링 강제 업데이트 (오류 방지)
    window.getComputedStyle(div).transform;
    
    // 이동 애니메이션 시작
    requestAnimationFrame(() => {
        div.style.webkitTransition = '-webkit-transform 6s linear';
        div.style.transition = 'transform 6s linear';
        
        // 화면 왼쪽 끝까지 완벽하게 가로지르기
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

// 5. 레이저 포인터 (마우스 움직임)
let lastSentTime = 0;
document.addEventListener('mousemove', (e) => {
    if (!roomId) return;
    const now = Date.now();
    if (now - lastSentTime > 50) { // 50ms 마다 전송 (트래픽 방지)
        const x = e.clientX / window.innerWidth;
        const y = e.clientY / window.innerHeight;
        socket.emit('room-event', { roomId, type: 'laser', data: {x, y} });
        lastSentTime = now;
    }
});

// 7. 모던 UI 컨트롤 (Flex 레이아웃 버그 수정)
function showFeatures() {
    document.getElementById('lobbyContainer').style.display = 'none';
    document.getElementById('theaterContainer').style.display = 'flex'; // block 대신 flex 사용 필수!
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
