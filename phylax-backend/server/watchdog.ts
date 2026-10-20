import { spawn } from "node:child_process";

/**
 * The systemd watchdog.
 *
 * The scheduler already exits the process when a tick hangs (see scheduler.ts), which is the primary guard. This
 * is the second layer, and it covers the case where the process cannot even run its own guard any more: a
 * deadlock, a stuck event loop, a wedged GC. systemd restarts the unit if it stops hearing from us, and it does
 * not care why.
 *
 * The ping is conditional on the scheduler actually being healthy. An unconditional ping would defeat the whole
 * point: a process with a stuck scheduler would keep saying "still alive" and systemd would never act.
 *
 * How the ping is sent: Node's `dgram` only does UDP (it has no unix-datagram socket type at all — verified:
 * `createSocket("unix_datagram")` throws ERR_SOCKET_BAD_TYPE), and systemd's notify socket is a unix datagram
 * socket. So the ping goes through `systemd-notify`, which is part of systemd itself and is present wherever the
 * unit file is. If it is not there, or we are not running under systemd at all, there is simply no watchdog —
 * which is the correct outcome on a development machine.
 */
export function startSystemdWatchdog(isHealthy: () => boolean, intervalMs = 30000): (() => void) | null {
  const address = process.env.NOTIFY_SOCKET;
  if (!address) return null;

  const ping = () => {
    if (!isHealthy()) return; // go quiet, and let systemd do its job
    const child = spawn("systemd-notify", ["WATCHDOG=1"], { stdio: "ignore", env: { ...process.env, NOTIFY_SOCKET: address } });
    // The ping must never keep the process alive, and a failure must never be fatal.
    child.on("error", () => {});
    child.unref();
  };

  const timer = setInterval(ping, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
