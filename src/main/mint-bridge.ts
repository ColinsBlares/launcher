import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

type Message = Record<string, any>;
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class MintBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private notify: (channel: string, data: unknown) => void;
  private commandSet = new Set<string>();

  constructor(notify: (channel: string, data: unknown) => void) { this.notify = notify; }
  isRunning() { return !!this.child && !this.child.killed; }

  async start(executable: string) {
    if (this.isRunning()) return { running: true, commands: [...this.commandSet] };
    this.child = spawn(executable, ["--api"], {
      // MiNT performs resource staging relative to its working directory.
      // Run it from the writable LocalAppData copy, never from Program Files.
      cwd: dirname(executable),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const current = this.child;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve; this.readyReject = reject;
      const timer = setTimeout(() => reject(new Error("MiNT API не прислал событие ready за 20 секунд")), 20000);
      timer.unref();
    });
    const lines = createInterface({ input: current.stdout });
    lines.on("line", line => this.handleLine(line));
    current.stderr.on("data", chunk => this.notify("mint:log", String(chunk).trim()));
    current.on("error", err => {
      this.failAll(err);
      this.notify("mint:state", { state: "error", message: err.message });
    });
    current.on("exit", (code, signal) => {
      this.failAll(new Error(`MiNT завершился (code=${code}, signal=${signal})`));
      this.child = null;
      this.notify("mint:state", { state: "stopped", code, signal });
    });
    await ready;
    this.notify("mint:state", { state: "ready", commands: [...this.commandSet] });
    return { running: true, commands: [...this.commandSet] };
  }

  private handleLine(line: string) {
    let message: Message;
    try { message = JSON.parse(line); }
    catch { this.notify("mint:log", `Не JSON от MiNT: ${line}`); return; }

    if (message.event === "ready") {
      this.commandSet = new Set(message.commands ?? []);
      this.readyResolve?.(); this.readyResolve = null; this.readyReject = null;
      return;
    }
    if (message.event) {
      this.notify("mint:event", message);
      if (message.event === "trust.required") {
        this.notify("mint:trust-required", message);
      }
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const item = this.pending.get(message.id)!;
      clearTimeout(item.timer);
      this.pending.delete(message.id);
      if (message.ok) item.resolve(message.result);
      else item.reject(new Error(`${message.error?.code ?? "MINT_ERROR"}: ${message.error?.message ?? "Неизвестная ошибка MiNT"}`));
    }
  }

  request(command: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.child || !this.child.stdin.writable) return Promise.reject(new Error("MiNT API не запущен"));
    if (this.commandSet.size && !this.commandSet.has(command)) return Promise.reject(new Error(`Команда ${command} не поддерживается этой версией MiNT`));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, command, ...params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Таймаут команды MiNT: ${command}`));
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(payload, "utf8", error => {
        if (error) {
          clearTimeout(timer); this.pending.delete(id); reject(error);
        }
      });
    });
  }

  private failAll(error: Error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.readyReject?.(error); this.readyReject = null; this.readyResolve = null;
  }
  kill() {
    this.failAll(new Error("Лаунчер закрывается"));
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }
}