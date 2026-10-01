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
let peerConnection;
let roomId;
let isHost = false;

// 오디오 증폭기 전역 변수
let remoteAudioCtx;
let remoteGainNode;

function initAudioBooster() {
    if (!remoteAudioCtx) {
        // 반드시 유저 클릭 이벤트 안에서 최초 생성해야 iOS에서 막히지 않음
        remoteAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        remoteGainNode = remoteAudioCtx.createGain();
        remoteGainNode.connect(remoteAudioCtx.destination);
        
        const voiceVolInput = document.getElementById('voiceVol');
        const volLabel = document.getElementById('volLabel');
        if (voiceVolInput) {
            remoteGainNode.gain.value = voiceVolInput.value;
            voiceVolInput.addEventListener('input', (e) => {
                const val = e.target.value;
                volLabel.innerText = `${val}x ${val == 1 ? '(기본)' : ''}`;
                remoteGainNode.gain.value = val;
            });
        }
        
        // iOS Safari AudioContext Resume 처리
        if (remoteAudioCtx.state === 'suspended') {
            remoteAudioCtx.resume();
        }
    }
}

function applyAudioBooster(stream) {
    if (!remoteAudioCtx || !remoteGainNode) return;
    
    // 비디오 태그의 기존 오디오는 끄기(중복 소리 방지)
    remoteCam.muted = true;
    
    if (!stream.boostConnected && stream.getAudioTracks().length > 0) {
        const source = remoteAudioCtx.createMediaStreamSource(stream);
        source.connect(remoteGainNode);
        stream.boostConnected = true;
    }
}

// 오디오 증폭기 전역 변수
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
        // 1. 영화 화면(오디오 포함) 캡처
        screenStream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { cursor: "always", frameRate: 30, height: { ideal: 720 } },
            audio: true 
        });
        
        videoPlayer.srcObject = screenStream;
        videoPlayer.muted = true; // 본인은 영화 소리 뮤트(원래 플레이어에서 나옴)
        
        // 2. 내 웹캠(얼굴+목소리) 캡처
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 240, frameRate: 15 },
            audio: true
        });
        
        localCam.srcObject = webcamStream;
        localCamBox.style.display = 'block'; remoteCamBox.style.display = 'block';
        
        isHost = true;
        socket.emit('join-room', roomId);
        
        statusDiv.innerText = `호스트 모드: [${roomId}] 방에 입장했습니다. 민지님을 기다리는 중...`;
        disableInputs();

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
        disableInputs();
    } catch(err) {
        console.error("Error accessing camera: ", err);
        alert("카메라/마이크 권한이 필요합니다.");
    }
});

// 게스트 접속 시 (호스트에서만 실행됨)
socket.on('user-connected', async (userId) => {
    if (!isHost) return;
    
    console.log('Guest connected:', userId);
    statusDiv.innerText = `민지님이 입장했습니다! 연결 중...`;
    
    createPeerConnection(userId);

    // 영화 스트림 트랙 추가
    screenStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, screenStream);
    });
    
    // 웹캠 스트림 트랙 추가
    webcamStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, webcamStream);
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    // 스트림 ID도 같이 보내서 상대방이 어느게 영화고 어느게 웹캠인지 구분하게 함
    socket.emit('offer', {
        target: userId,
        caller: socket.id,
        sdp: peerConnection.localDescription,
        screenStreamId: screenStream.id,
        webcamStreamId: webcamStream.id
    });
});

// Offer 수신 시 (게스트에서만 실행됨)
socket.on('offer', async (payload) => {
    if (isHost) return;

    createPeerConnection(payload.caller);
    
    // 호스트가 보낸 스트림 ID 저장해두기
    window.hostScreenStreamId = payload.screenStreamId;
    window.hostWebcamStreamId = payload.webcamStreamId;

    await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));

    // 내 웹캠 스트림 트랙 추가해서 답변에 포함
    webcamStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, webcamStream);
    });

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer', {
        target: payload.caller,
        caller: socket.id,
        sdp: peerConnection.localDescription
    });
});

// 호스트가 Answer 수신 시
socket.on('answer', async (payload) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    statusDiv.innerText = `성공적으로 연결되었습니다! 즐거운 관람 되세요 🍿`;
});

// ICE 
socket.on('ice-candidate', async (incoming) => {
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(incoming.candidate));
    } catch (e) {
        console.error('Error adding received ice candidate', e);
    }
});

function createPeerConnection(targetUserId) {
    peerConnection = new RTCPeerConnection(configuration);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: targetUserId,
                candidate: event.candidate
            });
        }
    };

    peerConnection.ontrack = (event) => {
        const stream = event.streams[0];
        
        if (isHost) {
            // 호스트는 게스트의 웹캠 스트림만 받음
            if (remoteCam.srcObject !== stream) {
                remoteCam.srcObject = stream; applyAudioBooster(stream);
            }
        } else {
            // 게스트는 호스트로부터 영화와 웹캠 두 가지 스트림을 받음
            if (stream.id === window.hostScreenStreamId) {
                if (videoPlayer.srcObject !== stream) {
                    videoPlayer.srcObject = stream;
                    statusDiv.innerText = `영화 스트리밍 수신 중 🍿`;
                }
            } else {
                if (remoteCam.srcObject !== stream) {
                    remoteCam.srcObject = stream; applyAudioBooster(stream);
                }
            }
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            statusDiv.innerText = `연결이 끊어졌습니다.`;
            statusDiv.style.color = '#E50914';
        }
    };
}

function disableInputs() {
    hostBtn.disabled = true;
    joinBtn.disabled = true;
    roomInput.disabled = true;
}
