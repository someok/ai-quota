import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";

const FIXED_SECRET_MASK = "••••••••";

export class PromptSession {
  private readonly input = stdin;
  private readonly output = stdout;
  private readline: Interface;

  constructor() {
    this.readline = this.createReadline();
  }

  private createReadline(): Interface {
    return createInterface({ input: this.input, output: this.output });
  }

  private supportsRawMode(): boolean {
    return Boolean(this.input.isTTY && typeof this.input.setRawMode === "function");
  }

  private enterRawMode(): void {
    this.readline.close();
    this.input.pause();
    this.input.setRawMode(true);
    this.input.resume();
  }

  private leaveRawMode(): void {
    this.input.setRawMode(false);
    this.input.pause();
    this.readline = this.createReadline();
  }

  async text(
    message: string,
    options: { defaultValue?: string; required?: boolean } = {},
  ): Promise<string> {
    const suffix = options.defaultValue ? ` [${options.defaultValue}]` : "";
    while (true) {
      const value = (await this.readline.question(`${message}${suffix}: `)).trim();
      if (value) return value;
      if (options.defaultValue !== undefined) return options.defaultValue;
      if (!options.required) return "";
      this.output.write("此项不能为空。\n");
    }
  }

  async secret(message: string, options: { keepExisting?: boolean } = {}): Promise<string> {
    const prompt = `${message}${options.keepExisting ? "（留空保留）" : ""}: `;
    if (!this.supportsRawMode()) {
      return this.text(`${message}${options.keepExisting ? "（留空保留）" : ""}`, {
        required: !options.keepExisting,
      });
    }

    this.enterRawMode();
    let value = "";
    const render = () => {
      this.output.write(`\r\x1b[2K${prompt}${value ? FIXED_SECRET_MASK : ""}`);
    };
    render();

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        this.input.off("data", onData);
        this.output.write("\n");
        this.leaveRawMode();
      };
      const finish = () => {
        if (!value && !options.keepExisting) {
          this.output.write("\x07");
          return;
        }
        cleanup();
        resolve(value);
      };
      const onData = (buffer: Buffer) => {
        const text = buffer
          .toString("utf8")
          .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "");
        let changed = false;
        for (const character of text) {
          if (character === "\u0003") {
            cleanup();
            reject(new Error("操作已取消"));
            return;
          }
          if (character === "\r" || character === "\n") {
            finish();
            return;
          }
          if (character === "\u007f" || character === "\b") {
            const characters = [...value];
            if (characters.length > 0) {
              characters.pop();
              value = characters.join("");
              changed = true;
            }
            continue;
          }
          if (character >= " " && character !== "\u007f") {
            value += character;
            changed = true;
          }
        }
        if (changed) render();
      };
      this.input.on("data", onData);
    });
  }

  async confirm(message: string, defaultValue = false): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N";
    const answer = (await this.readline.question(`${message} [${hint}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return answer === "y" || answer === "yes" || answer === "是";
  }

  async choose<T extends string>(
    message: string,
    options: readonly { value: T; label: string }[],
  ): Promise<T> {
    if (options.length === 0) throw new Error("没有可选择的项目");
    if (!this.supportsRawMode()) {
      this.output.write(`${message}\n`);
      options.forEach((option, index) => this.output.write(`  ${index + 1}. ${option.label}\n`));
      while (true) {
        const answer = await this.text("请选择", { required: true });
        const index = Number.parseInt(answer, 10) - 1;
        if (index >= 0 && index < options.length) return options[index]!.value;
        this.output.write(`请输入 1-${options.length}。\n`);
      }
    }

    this.output.write(`${message}\n`);
    this.enterRawMode();
    let selected = 0;
    let rendered = false;
    const render = () => {
      if (rendered) this.output.write(`\x1b[${options.length}A`);
      options.forEach((option, index) => {
        const marker = index === selected ? "❯" : " ";
        this.output.write(`\r\x1b[2K${marker} ${option.label}\n`);
      });
      rendered = true;
    };
    render();

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        this.input.off("data", onData);
        this.leaveRawMode();
      };
      const onData = (buffer: Buffer) => {
        const tokens = buffer
          .toString("utf8")
          .match(/\x1b\[A|\x1b\[B|\r|\n|\u0003|[1-9]/gu) ?? [];
        for (const token of tokens) {
          if (token === "\u0003") {
            cleanup();
            reject(new Error("操作已取消"));
            return;
          }
          if (token === "\x1b[A") {
            selected = (selected - 1 + options.length) % options.length;
            render();
          } else if (token === "\x1b[B") {
            selected = (selected + 1) % options.length;
            render();
          } else if (token === "\r" || token === "\n") {
            const result = options[selected]!.value;
            cleanup();
            resolve(result);
            return;
          } else {
            const numeric = Number.parseInt(token, 10) - 1;
            if (numeric >= 0 && numeric < options.length) {
              selected = numeric;
              render();
            }
          }
        }
      };
      this.input.on("data", onData);
    });
  }

  close(): void {
    this.readline.close();
  }
}
