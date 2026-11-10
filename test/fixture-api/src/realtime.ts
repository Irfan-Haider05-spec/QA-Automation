/**
 * Socket.IO for the fixture. Tokens are checked like the real backend (auth_error, then disconnect).
 * Planted bugs: no shared adapter (two processes don't see each other's events) and
 * no per-user connection cap.
 */
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { readToken } from "./store";

let io: Server | undefined;

export function attachRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: false } });
  io.on("connection", (socket) => {
    const token = (socket.handshake.auth as { token?: string })?.token;
    const user = token ? readToken(token) : null;
    // FIXTURE_SOCKET_OPEN=1: the self-test's "forgot to check tokens" server
    if (!user && process.env.FIXTURE_SOCKET_OPEN === "1") return;
    if (!user) {
      socket.emit("auth_error", token ? "Invalid token" : "Authentication token required");
      socket.disconnect(true);
      return;
    }
    socket.join(`user:${user.id}`);
  });
}

export function notifyUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function broadcast(event: string, payload: unknown) {
  io?.emit(event, payload);
}
