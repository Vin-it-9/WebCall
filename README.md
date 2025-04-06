# WebVCall - WebRTC Video Calling Application

## Overview

WebVCall is a modern, peer-to-peer video calling application built using WebRTC technology. It enables high-quality, real-time audio and video communication directly between browsers without requiring additional plugins or software installations.

## Features

- **Real-time Video Calls**: High-quality video and audio communication
- **No Account Required**: Join calls instantly with just a name and room code
- **Responsive Design**: Works seamlessly on desktop and mobile devices
- **Dark/Light Mode**: Choose your preferred viewing experience
- **Mute Controls**: Easily toggle audio and video during calls
- **Connection Status**: Visual indicators of connection state
- **Room-Based Communication**: Create or join rooms for private conversations
- **Modern UI/UX**: Beautiful interface with glassmorphism effects and animations

## Technologies Used

- **Frontend**:
  - HTML, CSS, JavaScript
  - Tailwind CSS
  - Font Awesome icons
  - WebRTC API for peer-to-peer connections

- **Backend**:
  - Quarkus 
  - WebSocket for signaling
  - STUN/TURN servers for NAT traversal
  - WebRTC

## Prerequisites

- Java 21
- Maven


## Installation

### Clone the repository

```bash
git clone https://github.com/Vin-it-9/stellar-connect.git
cd stellar-connect
```

### Build the application

```bash
./mvnw clean package
```

### Run locally

```bash
./mvnw quarkus:dev
```

The application will be available at `http://localhost:8080`

## Usage Guide

### Starting a Call

1. Open the application in your browser
2. Enter your name in the "Display Name" field
3. Create a room code or use an existing one
4. Click "Join Call"
5. Allow camera and microphone permissions when prompted

### Joining a Call

1. Get the room code from the person you want to call
2. Enter your name and the shared room code
3. Click "Join Call"
4. You should be connected automatically



## Troubleshooting

### Camera/Microphone Access Issues

- Ensure your browser has permission to access your camera and microphone
- Use HTTPS when accessing the application (especially on mobile devices)
- Try a different browser if you continue to experience issues

### Connection Problems

- Check that both users are using the same room code
- Ensure your internet connection is stable
- If behind a restrictive firewall, you may need to use a TURN server

### Mobile Device Issues

- Make sure to use HTTPS on mobile devices
- Some older mobile browsers have limited WebRTC support
- For iOS devices, Safari provides the best WebRTC support

