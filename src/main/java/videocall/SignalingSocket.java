package videocall;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.websocket.OnClose;
import jakarta.websocket.OnError;
import jakarta.websocket.OnMessage;
import jakarta.websocket.OnOpen;
import jakarta.websocket.Session;
import jakarta.websocket.server.PathParam;
import jakarta.websocket.server.ServerEndpoint;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.ByteBuffer;

@ServerEndpoint("/signal/{username}")
@ApplicationScoped
public class SignalingSocket {

    private ObjectMapper mapper = new ObjectMapper();

    private Map<String, Session> sessions = new ConcurrentHashMap<>();

    private Map<String, Set<String>> rooms = new ConcurrentHashMap<>();

    private final ScheduledExecutorService pingScheduler = Executors.newScheduledThreadPool(1);

    public SignalingSocket() {
        pingScheduler.scheduleAtFixedRate(this::pingAllSessions, 0, 20, TimeUnit.SECONDS);
    }

    private void pingAllSessions() {
        ByteBuffer pingData = ByteBuffer.wrap("keepalive".getBytes());
        sessions.values().forEach(session -> {
            try {
                if (session.isOpen()) {
                    session.getAsyncRemote().sendPing(pingData);
                    System.out.println("Sent ping to keep connection alive");
                }
            } catch (Exception e) {
                System.out.println("Failed to send ping: " + e.getMessage());
            }
        });
    }

    @OnOpen
    public void onOpen(Session session, @PathParam("username") String username) {
        System.out.println("Connected: " + username);
        sessions.put(username, session);

        session.setMaxIdleTimeout(300000);
    }

    @OnClose
    public void onClose(Session session, @PathParam("username") String username) {
        System.out.println("Disconnected: " + username);
        sessions.remove(username);

        rooms.forEach((roomId, users) -> {
            boolean removed = users.remove(username);
            if (removed) {
                broadcastToRoom(roomId, createMessage("leave", username, roomId, null));
            }
        });
    }

    @OnError
    public void onError(Session session, @PathParam("username") String username, Throwable throwable) {
        System.out.println("Error: " + username + ", " + throwable.getMessage());
        sessions.remove(username);
    }

    @OnMessage
    public void onMessage(String message, @PathParam("username") String username) {
        try {
            Map<String, Object> msgMap = mapper.readValue(message, Map.class);
            String type = (String) msgMap.get("type");
            String roomId = (String) msgMap.get("room");

            System.out.println("Received message type: " + type + " from user: " + username);

            if ("join".equals(type)) {
                handleJoinRoom(username, roomId);
            } else if ("ping".equals(type)) {
                sendToUser(username, createMessage("pong", "server", roomId, null));
            } else {
                broadcastToRoom(roomId, message, username);
            }
        } catch (Exception e) {
            System.out.println("Error processing message: " + e.getMessage());
        }
    }

    private void handleJoinRoom(String username, String roomId) {

        rooms.computeIfAbsent(roomId, k -> ConcurrentHashMap.newKeySet());

        Set<String> users = rooms.get(roomId);
        boolean isInitiator = users.isEmpty();

        users.add(username);
        System.out.println("User " + username + " joined room " + roomId + ". Is initiator: " + isInitiator);

        broadcastToRoom(roomId, createMessage("join", username, roomId, isInitiator));
    }

    private String createMessage(String type, String username, String roomId, Boolean initiator) {
        try {
            Map<String, Object> message = new ConcurrentHashMap<>();
            message.put("type", type);
            message.put("username", username);
            message.put("room", roomId);
            if (initiator != null) {
                message.put("initiator", initiator);
            }
            return mapper.writeValueAsString(message);
        } catch (Exception e) {
            return "{}";
        }
    }

    private void broadcastToRoom(String roomId, String message) {
        broadcastToRoom(roomId, message, null);
    }

    private void broadcastToRoom(String roomId, String message, String excludeUsername) {
        Set<String> users = rooms.get(roomId);
        if (users != null) {
            users.stream()
                    .filter(username -> !username.equals(excludeUsername))
                    .map(username -> sessions.get(username))
                    .forEach(session -> {
                        if (session != null && session.isOpen()) {
                            session.getAsyncRemote().sendText(message);
                        }
                    });
        }
    }

    private void sendToUser(String username, String message) {
        Session session = sessions.get(username);
        if (session != null && session.isOpen()) {
            session.getAsyncRemote().sendText(message);
        }
    }
}