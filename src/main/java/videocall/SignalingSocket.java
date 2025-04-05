package videocall;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.websocket.OnClose;
import jakarta.websocket.OnError;
import jakarta.websocket.OnMessage;
import jakarta.websocket.OnOpen;
import jakarta.websocket.Session;
import jakarta.websocket.server.PathParam;
import jakarta.websocket.server.ServerEndpoint;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

@ServerEndpoint("/signal/{username}")
@ApplicationScoped
public class SignalingSocket {

    private ObjectMapper mapper = new ObjectMapper();

    private Map<String, Session> sessions = new ConcurrentHashMap<>();

    private Map<String, Set<String>> rooms = new ConcurrentHashMap<>();

    @OnOpen
    public void onOpen(Session session, @PathParam("username") String username) {
        System.out.println("Connected: " + username);
        sessions.put(username, session);
    }

    @OnClose
    public void onClose(Session session, @PathParam("username") String username) {
        System.out.println("Disconnected: " + username);
        sessions.remove(username);

        rooms.forEach((roomId, users) -> {
            boolean removed = users.remove(username);
            if (removed) {
                try {
                    Map<String, Object> leaveMsg = new ConcurrentHashMap<>();
                    leaveMsg.put("type", "leave");
                    leaveMsg.put("username", username);
                    leaveMsg.put("room", roomId);
                    broadcastToRoom(roomId, mapper.writeValueAsString(leaveMsg));
                } catch (JsonProcessingException e) {
                    System.out.println("Error creating leave message: " + e.getMessage());
                }
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

            System.out.println("Received " + type + " message from " + username + " for room " + roomId);

            if ("join".equals(type)) {
                handleJoinRoom(username, roomId);
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
        boolean isFirstUser = users.isEmpty();
        users.add(username);

        System.out.println("User " + username + " joined room " + roomId + ". Is first user: " + isFirstUser);
        System.out.println("Room now has users: " + users);

        try {
            Map<String, Object> joinMsg = new ConcurrentHashMap<>();
            joinMsg.put("type", "join");
            joinMsg.put("username", username);
            joinMsg.put("room", roomId);
            joinMsg.put("initiator", isFirstUser);

            String joinMessage = mapper.writeValueAsString(joinMsg);
            broadcastToRoom(roomId, joinMessage);
        } catch (JsonProcessingException e) {
            System.out.println("Error creating join message: " + e.getMessage());
        }
    }

    private void broadcastToRoom(String roomId, String message) {
        broadcastToRoom(roomId, message, null);
    }

    private void broadcastToRoom(String roomId, String message, String excludeUsername) {
        Set<String> users = rooms.get(roomId);
        if (users != null) {
            System.out.println("Broadcasting to room " + roomId + " with " + users.size() + " users" +
                    (excludeUsername != null ? " (excluding " + excludeUsername + ")" : ""));

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
}