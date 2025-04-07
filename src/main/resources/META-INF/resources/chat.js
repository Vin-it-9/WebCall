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
    let peerConnection;
    let socket;
    let username;
    let roomId;
    let isInitiator = false;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    let pingInterval;
    let socketReconnectTimeout;

    let connectionMonitorInterval;
    let lastIceConnectionState = null;
    let disconnectionTimer = null;
    let keepAliveInterval = null;
    let hasRemoteUserLeft = false;
    let isCallActive = false;

    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            // More TURN servers for NAT traversal
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
        iceTransportPolicy: 'all'
    };

    joinBtn.addEventListener('click', async () => {
        username = usernameInput.value.trim();
        roomId = roomIdInput.value.trim();

        if (!username || !roomId) {
            updateStatus('Please enter both a username and room ID');
            return;
        }

        try {

            localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                },
                audio: true
            });


            localVideo.srcObject = localStream;
            updateStatus('Connecting to signaling server...');

            connectToSignalingServer();

            joinBtn.disabled = true;
            usernameInput.disabled = true;
            roomIdInput.disabled = true;
            isCallActive = true;

            startKeepAlive();

        } catch (err) {
            console.error('Error accessing media devices:', err);
            updateStatus('Error: ' + err.message);
        }
    });

    function connectToSignalingServer() {
        if (socketReconnectTimeout) {
            clearTimeout(socketReconnectTimeout);
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/signal/${username}`;

        updateStatus('Connecting to: ' + wsUrl);

        try {
            socket = new WebSocket(wsUrl);

            socket.onopen = () => {
                console.log('Connected to signaling server');
                signalingStatus.textContent = 'Connected';
                updateStatus('Connected to signaling server');
                reconnectAttempts = 0;
                hasRemoteUserLeft = false;

                // Send join room message
                sendSignalingMessage({
                    type: 'join',
                    room: roomId
                });

                clearInterval(pingInterval);
                pingInterval = setInterval(() => {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        sendSignalingMessage({
                            type: 'ping',
                            room: roomId,
                            timestamp: Date.now()
                        });
                    }
                }, 15000);
            };

            socket.onmessage = async (event) => {
                try {
                    const message = JSON.parse(event.data);

                    if (message.type === 'pong') {
                        return;
                    }

                    switch (message.type) {
                        case 'join':
                            console.log('Join message received. User:', message.username, 'Initiator:', message.initiator);
                            isInitiator = message.initiator;
                            hasRemoteUserLeft = false;

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
                            hasRemoteUserLeft = false;

                            clearDisconnectionTimer();

                            if (!peerConnection) {
                                createPeerConnection();
                            }
                            await handleOffer(message);
                            break;

                        case 'answer':
                            console.log('Answer received');
                            hasRemoteUserLeft = false;

                            clearDisconnectionTimer();

                            await handleAnswer(message);
                            break;

                        case 'ice-candidate':
                            hasRemoteUserLeft = false;
                            clearDisconnectionTimer();

                            await handleIceCandidate(message);
                            break;

                        case 'leave':
                            console.log('User left');
                            hasRemoteUserLeft = true;
                            handleUserLeft();
                            break;

                        case 'keep-alive':
                            sendSignalingMessage({
                                type: 'keep-alive-ack',
                                room: roomId,
                                timestamp: message.timestamp
                            });
                            break;

                        case 'reconnect-request':
                            if (peerConnection) {
                                console.log("Received reconnection request, restarting ICE");
                                restartConnection();
                            }
                            break;
                    }
                } catch (error) {
                    console.error('Error handling message:', error);
                }
            };

            socket.onclose = (event) => {
                console.log('Disconnected from signaling server:', event.code, event.reason);
                signalingStatus.textContent = 'Disconnected';
                updateStatus('Connection closed. Attempting to reconnect...');
                clearInterval(pingInterval);

                if (isCallActive && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    updateStatus(`Reconnecting... Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

                    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 16000);

                    socketReconnectTimeout = setTimeout(() => {
                        connectToSignalingServer();
                    }, delay);
                }
            };

            socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                signalingStatus.textContent = 'Error';
                updateStatus('Connection error');
            };
        } catch (e) {
            console.error('Error establishing WebSocket connection:', e);
            updateStatus('Error connecting to server: ' + e.message);
        }
    }

    function updateStatus(message, isError = false) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`Status: [${timestamp}] ${message}`);
        connectionStatus.textContent = message;
        connectionStatus.className = isError ? 'text-red-600' : 'text-gray-600';
    }

    function createPeerConnection() {
        console.log('Creating peer connection');

        try {
            peerConnection = new RTCPeerConnection(configuration);
            localStream.getTracks().forEach(track => {
                console.log('Adding track to peer connection:', track.kind);
                peerConnection.addTrack(track, localStream);
            });

            peerConnection.ontrack = (event) => {
                console.log('Received remote track:', event.track.kind);

                if (event.streams && event.streams[0]) {
                    console.log('Setting remote stream');
                    remoteVideo.srcObject = event.streams[0];
                    remoteConnectionState.textContent = "Video connected";
                    updateStatus("Remote user connected!");
                    hasRemoteUserLeft = false;
                    startConnectionMonitoring();
                }
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log('Generated ICE candidate');

                    sendSignalingMessage({
                        type: 'ice-candidate',
                        candidate: event.candidate,
                        room: roomId
                    });
                }
            };

            peerConnection.oniceconnectionstatechange = () => {
                console.log('ICE connection state:', peerConnection.iceConnectionState);
                iceStatus.textContent = peerConnection.iceConnectionState;
                lastIceConnectionState = peerConnection.iceConnectionState;

                if (peerConnection.iceConnectionState === 'connected' ||
                    peerConnection.iceConnectionState === 'completed') {
                    updateStatus('WebRTC connection established!');
                    clearDisconnectionTimer();
                }
                else if (peerConnection.iceConnectionState === 'disconnected') {
                    console.log("ICE connection disconnected, waiting before reconnection attempt");
                    setDisconnectionTimer();
                }
                else if (peerConnection.iceConnectionState === 'failed') {
                    updateStatus('Connection failed - attempting recovery');
                    restartConnection();
                }
            };

            peerConnection.onconnectionstatechange = () => {
                console.log('Connection state:', peerConnection.connectionState);

                if (peerConnection.connectionState === 'failed') {
                    if (!hasRemoteUserLeft) {
                        updateStatus('Connection failed - attempting recovery');
                        restartConnection();
                    }
                }
            };

        } catch (err) {
            console.error('Error creating peer connection:', err);
            updateStatus('Error creating connection');
        }
    }

    async function restartConnection() {
        if (!peerConnection || !isCallActive) return;

        console.log('Attempting to restart connection');

        try {
            if (isInitiator) {
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

                updateStatus('Sent reconnection offer');
            } else {
                sendSignalingMessage({
                    type: 'reconnect-request',
                    room: roomId
                });

                updateStatus('Requested connection restart');
            }
        } catch (err) {
            console.error('Error restarting connection:', err);
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
                setTimeout(() => {
                    if (isCallActive && !hasRemoteUserLeft) {
                        createPeerConnection();
                        if (isInitiator) {
                            setTimeout(createOffer, 1000);
                        }
                    }
                }, 1000);
            }
        }
    }

    function setDisconnectionTimer() {
        clearDisconnectionTimer();

        disconnectionTimer = setTimeout(() => {
            if (peerConnection &&
                (peerConnection.iceConnectionState === 'disconnected' ||
                    peerConnection.iceConnectionState === 'failed')) {

                console.log('Connection still disconnected after wait, attempting recovery');
                updateStatus('Connection interrupted - attempting to recover');
                restartConnection();
            }
        }, 5000);
    }

    function clearDisconnectionTimer() {
        if (disconnectionTimer) {
            clearTimeout(disconnectionTimer);
            disconnectionTimer = null;
        }
    }

    function startConnectionMonitoring() {
        if (connectionMonitorInterval) {
            clearInterval(connectionMonitorInterval);
        }

        connectionMonitorInterval = setInterval(async () => {
            if (!peerConnection || !isCallActive) return;

            try {

                const stats = await peerConnection.getStats();
                let bytesReceived = 0;
                let timestamp = Date.now();

                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        bytesReceived = report.bytesReceived;
                        if (report.timestamp && timestamp - report.timestamp > 5000 &&
                            bytesReceived === 0 && !hasRemoteUserLeft) {
                            console.warn('No video data received in last 5 seconds');

                            if (peerConnection.iceConnectionState !== 'disconnected' &&
                                peerConnection.iceConnectionState !== 'failed') {
                                console.log('Media appears stalled, attempting recovery');
                                restartConnection();
                            }
                        }

                        if (report.packetsLost > 0 && report.packetsReceived > 0) {
                            const lossRate = report.packetsLost / (report.packetsLost + report.packetsReceived);
                            if (lossRate > 0.15) {
                                console.warn(`High packet loss detected: ${Math.round(lossRate * 100)}%`);
                            }
                        }
                    }
                });
            } catch (err) {
                console.error('Error monitoring connection:', err);
            }
        }, 10000);
    }

    function startKeepAlive() {
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
        }

        keepAliveInterval = setInterval(() => {

            if (isCallActive && peerConnection) {

                sendSignalingMessage({
                    type: 'keep-alive',
                    room: roomId,
                    timestamp: Date.now()
                });

                if (peerConnection.connectionState === 'connected') {
                    try {
                        const senders = peerConnection.getSenders();
                        if (senders.length > 0) {
                            const params = senders[0].getParameters();
                            if (params.encodings && params.encodings.length > 0) {
                                const priority = params.encodings[0].priority;
                            }
                        }
                    } catch (e) {

                    }
                }
            }
        }, 5000);
    }

    async function createOffer() {
        if (!peerConnection) return;

        try {
            updateStatus('Creating offer...');

            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
                voiceActivityDetection: false,
                iceRestart: false
            });

            updateStatus('Setting local description...');
            await peerConnection.setLocalDescription(offer);

            updateStatus('Sending offer...');
            sendSignalingMessage({
                type: 'offer',
                sdp: peerConnection.localDescription,
                room: roomId
            });
        } catch (error) {
            console.error('Error creating offer:', error);
            updateStatus('Failed to create offer');
        }
    }

    async function handleOffer(message) {
        if (!peerConnection) return;

        try {
            updateStatus('Processing offer...');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));

            updateStatus('Creating answer...');
            const answer = await peerConnection.createAnswer();

            updateStatus('Setting local description...');
            await peerConnection.setLocalDescription(answer);

            updateStatus('Sending answer...');
            sendSignalingMessage({
                type: 'answer',
                sdp: peerConnection.localDescription,
                room: roomId
            });
        } catch (error) {
            console.error('Error handling offer:', error);
            updateStatus('Failed to process offer');
        }
    }

    async function handleAnswer(message) {
        if (!peerConnection) return;

        try {
            updateStatus('Processing answer...');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));
            updateStatus('Connection established with peer');
        } catch (error) {
            console.error('Error handling answer:', error);
            updateStatus('Failed to process answer');
        }
    }

    async function handleIceCandidate(message) {
        if (!peerConnection) return;

        try {
            if (message.candidate) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate))
                    .catch(e => {
                        // Ignore state errors - they're common and not critical
                        if (e.name !== 'InvalidStateError') {
                            console.error('Error adding ICE candidate:', e);
                        }
                    });
            }
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }

    function handleUserLeft() {
        hasRemoteUserLeft = true;

        if (remoteVideo.srcObject) {

            const tracks = remoteVideo.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            remoteVideo.srcObject = null;
        }

        remoteConnectionState.textContent = "User left";
        updateStatus('Remote user left the call');

        if (connectionMonitorInterval) {
            clearInterval(connectionMonitorInterval);
        }
    }

    function sendSignalingMessage(message) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify(message));
            } catch (e) {
                console.error('Error sending message:', e);
            }
        } else {
            console.warn('Cannot send message, socket not open', message);
        }
    }

    muteAudioBtn.addEventListener('click', () => {
        if (localStream) {
            const audioTracks = localStream.getAudioTracks();
            if (audioTracks.length > 0) {
                const audioTrack = audioTracks[0];
                audioTrack.enabled = !audioTrack.enabled;

                muteAudioBtn.classList.toggle('bg-red-600');

                console.log(`Audio ${audioTrack.enabled ? 'unmuted' : 'muted'}`);
            }
        }
    });

    muteVideoBtn.addEventListener('click', () => {
        if (localStream) {
            const videoTracks = localStream.getVideoTracks();
            if (videoTracks.length > 0) {
                const videoTrack = videoTracks[0];
                videoTrack.enabled = !videoTrack.enabled;

                muteVideoBtn.classList.toggle('bg-red-600');

                console.log(`Video ${videoTrack.enabled ? 'enabled' : 'disabled'}`);
            }
        }
    });

    hangupBtn.addEventListener('click', () => {
        isCallActive = false;
        hasRemoteUserLeft = true;

        sendSignalingMessage({
            type: 'leave',
            room: roomId
        });

        if (connectionMonitorInterval) clearInterval(connectionMonitorInterval);
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        if (disconnectionTimer) clearTimeout(disconnectionTimer);
        clearInterval(pingInterval);

        if (peerConnection) {

            peerConnection.oniceconnectionstatechange = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.onicecandidate = null;
            peerConnection.ontrack = null;

            peerConnection.close();
            peerConnection = null;
        }

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localVideo.srcObject = null;
        }

        if (remoteVideo.srcObject) {
            const tracks = remoteVideo.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            remoteVideo.srcObject = null;
        }

        joinBtn.disabled = false;
        usernameInput.disabled = false;
        roomIdInput.disabled = false;
        updateStatus('Call ended');
        remoteConnectionState.textContent = "Disconnected";
    });

    window.addEventListener('beforeunload', () => {
        isCallActive = false;

        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'leave',
                room: roomId
            }));
        }

        if (socket) {
            socket.close();
        }

        if (connectionMonitorInterval) clearInterval(connectionMonitorInterval);
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        if (disconnectionTimer) clearTimeout(disconnectionTimer);
        clearInterval(pingInterval);
        clearTimeout(socketReconnectTimeout);

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
    });
});