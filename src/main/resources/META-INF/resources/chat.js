document.addEventListener('DOMContentLoaded', () => {
    // DOM elements
    const joinBtn = document.getElementById('joinBtn');
    const hangupBtn = document.getElementById('hangupBtn');
    const muteAudioBtn = document.getElementById('muteAudioBtn');
    const muteVideoBtn = document.getElementById('muteVideoBtn');
    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');
    const usernameInput = document.getElementById('username');
    const roomIdInput = document.getElementById('roomId');
    const connectionStatus = document.getElementById('connectionStatus');
    const iceStatus = document.getElementById('ice-status');
    const signalingStatus = document.getElementById('signaling-status');
    const remoteConnectionState = document.getElementById('remoteConnectionState');

    let localStream;
    let screenShareStream;
    let peerConnection;
    let socket;
    let username;
    let roomId;
    let isInitiator = false;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 10;
    let pingInterval;
    let socketReconnectTimeout;
    let isConnectionActive = false;
    let iceGatheringComplete = false;
    let isReconnecting = false;
    let connectionHealthCheck;
    let statsInterval;

    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ],
        iceCandidatePoolSize: 10,
        iceTransportPolicy: 'all',
        sdpSemantics: 'unified-plan'
    };

    const defaultMediaConstraints = {
        video: {
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { max: 30, ideal: 24 },
            facingMode: 'user'
        },
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    };

    joinBtn.addEventListener('click', async () => {
        username = usernameInput.value.trim();
        roomId = roomIdInput.value.trim();

        if (!username || !roomId) {
            updateStatus('Please enter both a username and room ID', true);
            return;
        }

        try {
            updateStatus('Requesting camera and microphone access...');

            try {
                localStream = await navigator.mediaDevices.getUserMedia(defaultMediaConstraints);
            } catch (err) {
                console.warn('Failed to get media with preferred settings, trying fallback:', err);

                localStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: true
                });

                updateStatus('Using basic camera/mic settings due to constraints');
            }

            localVideo.srcObject = localStream;

            localVideo.onloadedmetadata = () => {
                localVideo.play()
                    .catch(e => console.error('Local video playback error:', e));
            };

            updateStatus('Camera and microphone connected. Connecting to server...');
            navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
            connectToSignalingServer();

            joinBtn.disabled = true;
            usernameInput.disabled = true;
            roomIdInput.disabled = true;
        } catch (err) {
            console.error('Error accessing media devices:', err);

            if (err.name === 'NotAllowedError') {
                updateStatus('Error: Camera/microphone permission denied. Please allow access and try again.', true);
            } else if (err.name === 'NotFoundError') {
                updateStatus('Error: No camera or microphone found on your device.', true);
            } else {
                updateStatus(`Error: ${err.message}`, true);
            }
        }
    });

    async function handleDeviceChange() {
        if (!localStream) return;

        console.log('Media devices changed');

        if (peerConnection && peerConnection.connectionState === 'connected') {
            try {
                const hasVideo = localStream.getVideoTracks().length > 0;
                const hasAudio = localStream.getAudioTracks().length > 0;

                if (!hasVideo && !hasAudio) return;

                const newStream = await navigator.mediaDevices.getUserMedia({
                    video: hasVideo,
                    audio: hasAudio
                });

                const senders = peerConnection.getSenders();

                if (hasVideo) {
                    const videoTrack = newStream.getVideoTracks()[0];
                    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                    if (videoSender && videoTrack) {
                        await videoSender.replaceTrack(videoTrack);
                    }

                    const oldVideoTrack = localStream.getVideoTracks()[0];
                    if (oldVideoTrack) oldVideoTrack.stop();
                    localStream.removeTrack(oldVideoTrack);
                    localStream.addTrack(videoTrack);
                }

                if (hasAudio) {
                    const audioTrack = newStream.getAudioTracks()[0];
                    const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
                    if (audioSender && audioTrack) {
                        await audioSender.replaceTrack(audioTrack);
                    }

                    const oldAudioTrack = localStream.getAudioTracks()[0];
                    if (oldAudioTrack) oldAudioTrack.stop();
                    localStream.removeTrack(oldAudioTrack);
                    localStream.addTrack(audioTrack);
                }

                localVideo.srcObject = localStream;
            } catch (err) {
                console.error('Error handling device change:', err);
            }
        }
    }

    function connectToSignalingServer() {
        if (socketReconnectTimeout) {
            clearTimeout(socketReconnectTimeout);
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/signal/${username}`;

        updateStatus('Connecting to signaling server...');

        try {
            socket = new WebSocket(wsUrl);

            const connectionTimeout = setTimeout(() => {
                if (socket.readyState !== WebSocket.OPEN) {
                    socket.close();
                    updateStatus('Connection timeout. Retrying...', true);
                    tryReconnect();
                }
            }, 10000);

            socket.onopen = () => {
                clearTimeout(connectionTimeout);
                console.log('Connected to signaling server');
                signalingStatus.textContent = 'Connected';
                updateStatus('Connected to signaling server');
                reconnectAttempts = 0;
                isReconnecting = false;

                sendSignalingMessage({
                    type: 'join',
                    room: roomId
                });

                clearInterval(pingInterval);
                pingInterval = setInterval(() => {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        const pingStartTime = Date.now();
                        sendSignalingMessage({
                            type: 'ping',
                            room: roomId,
                            timestamp: pingStartTime
                        });

                        setTimeout(() => {
                            if (socket && socket.pingTimeout && Date.now() - socket.lastPong > 45000) {
                                console.warn('Ping timeout, connection may be dead');
                                socket.close();
                            }
                        }, 30000);
                    }
                }, 15000);
            };

            socket.onmessage = async (event) => {
                try {
                    const message = JSON.parse(event.data);

                    if (message.type === 'pong') {
                        socket.lastPong = Date.now();
                        return;
                    }

                    switch (message.type) {
                        case 'join':
                            console.log('Join message received. User:', message.username, 'Initiator:', message.initiator);
                            isInitiator = message.initiator;

                            if (!peerConnection) {
                                createPeerConnection();
                                if (!isInitiator) {
                                    setTimeout(() => {
                                        createOffer();
                                    }, 1000);
                                }
                            }
                            break;

                        case 'offer':
                            console.log('Offer received');
                            if (!peerConnection || peerConnection.connectionState === 'failed') {
                                if (peerConnection) {
                                    peerConnection.close();
                                }
                                createPeerConnection();
                            }
                            await handleOffer(message);
                            break;

                        case 'answer':
                            console.log('Answer received');
                            await handleAnswer(message);
                            break;

                        case 'ice-candidate':
                            await handleIceCandidate(message);
                            break;

                        case 'leave':
                            console.log('User left');
                            handleUserLeft();
                            break;

                        case 'reconnect-request':
                            console.log('Reconnection requested');
                            if (peerConnection) {
                                restartIce();
                            }
                            break;
                    }
                } catch (error) {
                    console.error('Error handling message:', error);
                    updateStatus('Error processing message from server', true);
                }
            };

            socket.onclose = (event) => {
                clearTimeout(connectionTimeout);
                console.log('Disconnected from signaling server:', event.code, event.reason);
                signalingStatus.textContent = 'Disconnected';
                updateStatus('Signaling server disconnected');
                clearInterval(pingInterval);
                if (!isReconnecting && event.code !== 1000) {
                    tryReconnect();
                }
            };

            socket.onerror = (error) => {
                clearTimeout(connectionTimeout);
                console.error('WebSocket error:', error);
                signalingStatus.textContent = 'Error';
                updateStatus('Connection error', true);
            };
        } catch (e) {
            console.error('Error establishing WebSocket connection:', e);
            updateStatus('Error connecting to server: ' + e.message, true);
            tryReconnect();
        }
    }

    function tryReconnect() {

        if (isReconnecting || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;

        isReconnecting = true;

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            updateStatus(`Connection lost. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

            const baseDelay = 1000;
            const exponentialDelay = baseDelay * Math.pow(1.5, reconnectAttempts - 1);
            const jitter = Math.random() * 1000;
            const delay = Math.min(exponentialDelay + jitter, 30000);

            console.log(`Reconnecting in ${Math.round(delay/1000)} seconds...`);

            socketReconnectTimeout = setTimeout(() => {
                connectToSignalingServer();
            }, delay);
        } else {
            updateStatus('Could not reconnect to server after multiple attempts. Please refresh the page.', true);
        }
    }

    function restartIce() {
        if (!peerConnection) return;

        try {
            console.log('Attempting ICE restart');
            updateStatus('Attempting to recover connection...');

            if (peerConnection.restartIce) {
                peerConnection.restartIce();
                if (isInitiator) {
                    createOfferWithRestart();
                }
            } else {
                recreatePeerConnection();
            }
        } catch (err) {
            console.error('Error during ICE restart:', err);
            recreatePeerConnection();
        }
    }

    async function createOfferWithRestart() {
        if (!peerConnection) return;
        try {
            const offer = await peerConnection.createOffer({
                iceRestart: true,
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });

            await peerConnection.setLocalDescription(offer);

            sendSignalingMessage({
                type: 'offer',
                sdp: peerConnection.localDescription,
                room: roomId,
                isRestart: true
            });
        } catch (err) {
            console.error('Error creating restart offer:', err);
            recreatePeerConnection();
        }
    }

    function recreatePeerConnection() {
        console.log('Recreating peer connection');
        updateStatus('Re-establishing connection...');

        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        createPeerConnection();
        if (isInitiator) {
            setTimeout(() => {
                createOffer();
            }, 1000);
        }
    }

    function updateStatus(message, isError = false) {
        const timestamp = new Date().toLocaleTimeString();
        const formattedMessage = `[${timestamp}] ${message}`;

        console.log(`Status: ${formattedMessage}`);
        connectionStatus.textContent = message;
        connectionStatus.className = isError ? 'text-red-600' : 'text-gray-600';

        if (isError) {
            console.error(`Error: ${message}`);
        }
    }

    function createPeerConnection() {
        console.log('Creating peer connection');

        try {
            peerConnection = new RTCPeerConnection(configuration);
            iceGatheringComplete = false;

            if (localStream) {
                localStream.getTracks().forEach(track => {
                    console.log('Adding track to peer connection:', track.kind);
                    peerConnection.addTrack(track, localStream);
                });
            }

            peerConnection.ontrack = (event) => {
                console.log('Received remote track:', event.track.kind);

                if (event.streams && event.streams[0]) {
                    console.log('Setting remote stream');

                    remoteVideo.srcObject = event.streams[0];

                    remoteVideo.onloadedmetadata = () => {
                        remoteVideo.play()
                            .catch(e => console.error('Remote video playback error:', e));
                    };

                    remoteConnectionState.textContent = "Video connected";
                    updateStatus("Remote user connected!");

                    startConnectionMonitoring();
                }
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log('Generated ICE candidate:', event.candidate.type);

                    sendSignalingMessage({
                        type: 'ice-candidate',
                        candidate: event.candidate,
                        room: roomId
                    });
                } else {
                    console.log('All ICE candidates gathered');
                    iceGatheringComplete = true;
                }
            };

            peerConnection.oniceconnectionstatechange = () => {
                const state = peerConnection.iceConnectionState;
                console.log('ICE connection state changed:', state);
                iceStatus.textContent = state;

                switch (state) {
                    case 'connected':
                    case 'completed':
                        isConnectionActive = true;
                        updateStatus('WebRTC connection established!');

                        if (connectionHealthCheck) {
                            clearTimeout(connectionHealthCheck);
                        }
                        break;

                    case 'disconnected':
                        updateStatus('Connection interrupted. Attempting to recover...');

                        connectionHealthCheck = setTimeout(() => {
                            if (peerConnection.iceConnectionState === 'disconnected') {
                                restartIce();
                            }
                        }, 5000);
                        break;

                    case 'failed':
                        updateStatus('Connection failed - attempting recovery');
                        isConnectionActive = false;
                        restartIce();
                        break;

                    case 'closed':
                        isConnectionActive = false;
                        updateStatus('Connection closed');
                        break;
                }
            };

            peerConnection.onsignalingstatechange = () => {
                console.log('Signaling state:', peerConnection.signalingState);

                if (peerConnection.signalingState === 'closed') {
                    stopConnectionMonitoring();
                }
            };

            peerConnection.onconnectionstatechange = () => {
                console.log('Connection state:', peerConnection.connectionState);

                if (peerConnection.connectionState === 'failed') {
                    updateStatus('Connection failed - attempting recovery');
                    restartIce();
                }
            };

            peerConnection.onnegotiationneeded = async () => {
                console.log('Negotiation needed event');
                if (isInitiator) {
                    try {
                        await createOffer();
                    } catch (err) {
                        console.error('Error during negotiation:', err);
                    }
                }
            };

            setMediaBitrates();

        } catch (err) {
            console.error('Error creating peer connection:', err);
            updateStatus('Error creating connection', true);
        }
    }

    function setMediaBitrates() {
        peerConnection.currentRemoteDescription?.sdp?.split('\r\n').forEach(line => {
            if (line.startsWith('m=video')) {
                const videoSender = peerConnection.getSenders().find(s =>
                    s.track && s.track.kind === 'video'
                );

                if (videoSender && videoSender.setParameters) {
                    try {
                        const params = videoSender.getParameters();
                        if (params.encodings && params.encodings.length > 0) {
                            params.encodings[0].maxBitrate = 1000000;
                            videoSender.setParameters(params);
                        }
                    } catch (e) {
                        console.warn('Failed to set encoding parameters:', e);
                    }
                }
            }
        });
    }

    function startConnectionMonitoring() {
        if (statsInterval) {
            clearInterval(statsInterval);
        }

        statsInterval = setInterval(async () => {
            if (!peerConnection) return;

            try {
                const stats = await peerConnection.getStats();
                let hasActiveVideo = false;
                let hasActiveAudio = false;

                stats.forEach(report => {
                    if (report.type === 'inbound-rtp') {
                        if (report.kind === 'video' && report.bytesReceived > 0) {
                            hasActiveVideo = true;
                        } else if (report.kind === 'audio' && report.bytesReceived > 0) {
                            hasActiveAudio = true;
                        }

                        if (report.packetsLost > 0) {
                            const lossRate = report.packetsLost / (report.packetsReceived + report.packetsLost);
                            if (lossRate > 0.1) {
                                console.warn(`High ${report.kind} packet loss: ${Math.round(lossRate * 100)}%`);
                            }
                        }
                    }
                });

                if (peerConnection.connectionState === 'connected' && !hasActiveVideo) {
                    console.warn('Video appears to be stalled');
                }

            } catch (e) {
                console.error('Error getting connection stats:', e);
            }
        }, 5000);
    }

    function stopConnectionMonitoring() {
        if (statsInterval) {
            clearInterval(statsInterval);
            statsInterval = null;
        }
    }

    async function createOffer() {
        if (!peerConnection) return;

        try {
            updateStatus('Creating connection offer...');
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
                voiceActivityDetection: true
            });

            offer.sdp = enhanceSdp(offer.sdp);

            updateStatus('Setting local description...');
            await peerConnection.setLocalDescription(offer);
            await waitForIceGathering();
            updateStatus('Sending connection offer...');
            sendSignalingMessage({
                type: 'offer',
                sdp: peerConnection.localDescription,
                room: roomId
            });
        } catch (error) {
            console.error('Error creating offer:', error);
            updateStatus('Failed to create connection offer', true);
        }
    }

    function waitForIceGathering() {
        return new Promise(resolve => {
            if (iceGatheringComplete) {
                resolve();
                return;
            }

            const checkState = () => {
                if (peerConnection.iceGatheringState === 'complete') {
                    iceGatheringComplete = true;
                    resolve();
                }
            };

            checkState();

            const gatheringTimeout = setTimeout(() => {
                console.log('ICE gathering timed out, proceeding anyway');
                resolve();
            }, 3000);

            const onStateChange = () => {
                checkState();
                if (iceGatheringComplete) {
                    clearTimeout(gatheringTimeout);
                    peerConnection.removeEventListener('icegatheringstatechange', onStateChange);
                }
            };

            peerConnection.addEventListener('icegatheringstatechange', onStateChange);
        });
    }

    function enhanceSdp(sdp) {

        sdp = sdp.replace('useinbandfec=1', 'useinbandfec=1; stereo=1');

        const lines = sdp.split('\r\n');
        const videoLineIndex = lines.findIndex(line => line.startsWith('m=video'));

        if (videoLineIndex !== -1) {
            const h264Lines = lines.filter((line, index) =>
                index > videoLineIndex &&
                line.includes('H264') &&
                line.startsWith('a=rtpmap')
            );

            if (h264Lines.length > 0) {
                const h264Id = h264Lines[0].split(' ')[0].split(':')[1];
                const videoLine = lines[videoLineIndex];
                const parts = videoLine.split(' ');
                const idIndex = parts.indexOf(h264Id);

                if (idIndex !== -1) {
                    parts.splice(idIndex, 1);
                    parts.splice(3, 0, h264Id);
                    lines[videoLineIndex] = parts.join(' ');
                }
            }
        }

        return lines.join('\r\n');
    }

    async function handleOffer(message) {
        if (!peerConnection) return;

        try {
            updateStatus('Processing incoming connection...');

            const sdp = new RTCSessionDescription(message.sdp);
            sdp.sdp = enhanceSdp(sdp.sdp);

            await peerConnection.setRemoteDescription(sdp);

            updateStatus('Creating connection answer...');
            const answer = await peerConnection.createAnswer();

            answer.sdp = enhanceSdp(answer.sdp);

            updateStatus('Setting local description...');
            await peerConnection.setLocalDescription(answer);
            await waitForIceGathering();

            updateStatus('Sending connection answer...');
            sendSignalingMessage({
                type: 'answer',
                sdp: peerConnection.localDescription,
                room: roomId
            });
        } catch (error) {
            console.error('Error handling offer:', error);
            updateStatus('Failed to process connection request', true);
        }
    }

    async function handleAnswer(message) {
        if (!peerConnection) return;

        try {
            updateStatus('Processing connection answer...');
            const sdp = new RTCSessionDescription(message.sdp);
            sdp.sdp = enhanceSdp(sdp.sdp);
            await peerConnection.setRemoteDescription(sdp);
            updateStatus('Connection established with peer');
        } catch (error) {
            console.error('Error handling answer:', error);
            updateStatus('Failed to process connection answer', true);
        }
    }

    async function handleIceCandidate(message) {
        if (!peerConnection) return;

        try {
            if (message.candidate) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate))
                    .catch(e => {
                        if (e.name !== 'InvalidStateError') {
                            console.error('Error adding ICE candidate:', e);
                        }
                    });
            }
        } catch (error) {
            console.error('Error processing ICE candidate:', error);
        }
    }

    function handleUserLeft() {
        updateStatus('Remote user left the call');
        remoteConnectionState.textContent = "User left";
        if (remoteVideo.srcObject) {
            const tracks = remoteVideo.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            remoteVideo.srcObject = null;
        }
        if (peerConnection) {
            const receivers = peerConnection.getReceivers();
            receivers.forEach(receiver => {
                if (receiver.track) {
                    receiver.track.enabled = false;
                }
            });
        }
        stopConnectionMonitoring();
    }

    function sendSignalingMessage(message) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify(message));
            } catch (e) {
                console.error('Error sending message:', e);

                if (e.name === 'NetworkError') {
                    socket.close();
                }
            }
        } else {
            console.warn('Cannot send message, socket not open', message);
            if (['offer', 'answer', 'ice-candidate'].includes(message.type)) {
                if (!socket.pendingMessages) socket.pendingMessages = [];
                socket.pendingMessages.push(message);
            }
        }
    }

    muteAudioBtn.addEventListener('click', () => {
        if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                muteAudioBtn.classList.toggle('bg-red-600');
                if (!audioTrack.enabled) {
                    updateStatus('Microphone muted');
                } else {
                    updateStatus('Microphone unmuted');
                }
            }
        }
    });

    muteVideoBtn.addEventListener('click', () => {
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                muteVideoBtn.classList.toggle('bg-red-600');

                if (!videoTrack.enabled) {
                    updateStatus('Camera turned off');
                } else {
                    updateStatus('Camera turned on');
                }
            }
        }
    });

    hangupBtn.addEventListener('click', () => {
        leaveCall();
    });

    function leaveCall() {
        updateStatus('Ending call...');
        sendSignalingMessage({
            type: 'leave',
            room: roomId
        });

        stopConnectionMonitoring();

        if (connectionHealthCheck) {
            clearTimeout(connectionHealthCheck);
            connectionHealthCheck = null;
        }

        if (peerConnection) {
            peerConnection.onicecandidate = null;
            peerConnection.ontrack = null;
            peerConnection.oniceconnectionstatechange = null;
            peerConnection.onsignalingstatechange = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.onnegotiationneeded = null;
            peerConnection.close();
            peerConnection = null;
        }

        if (localStream) {
            localStream.getTracks().forEach(track => {
                track.stop();
            });
            localVideo.srcObject = null;
        }

        if (remoteVideo.srcObject) {
            const tracks = remoteVideo.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            remoteVideo.srcObject = null;
        }

        clearInterval(pingInterval);

        joinBtn.disabled = false;
        usernameInput.disabled = false;
        roomIdInput.disabled = false;
        updateStatus('Call ended');
        remoteConnectionState.textContent = "Disconnected";
        navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    }

    window.addEventListener('beforeunload', () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'leave',
                room: roomId
            }));
        }

        if (socket) {
            socket.close();
        }

        clearInterval(pingInterval);
        clearTimeout(socketReconnectTimeout);
        clearTimeout(connectionHealthCheck);
        clearInterval(statsInterval);

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (localStream && localStream.getVideoTracks().length > 0) {
                localStream.getVideoTracks()[0].applyConstraints({
                    frameRate: 5
                }).catch(e => console.log('Could not reduce framerate:', e));
            }
        } else {
            if (localStream && localStream.getVideoTracks().length > 0) {
                localStream.getVideoTracks()[0].applyConstraints({
                    frameRate: 24
                }).catch(e => console.log('Could not restore framerate:', e));
            }
        }
    });
});
