/** One filed (or failed) call: its companion and session name. */
export type FiledCall = { url: string; name: string; logs(): string };
export type LocalCarr = {
  url: string;
  e2eSecret: string;
  deals: Record<string, string>;
  setupMs: number;
  mcp(name: string, args?: object): Promise<unknown>;
  fileCall(options?: { distiller?: "stand-in" | "failing" }): Promise<FiledCall>;
  close(): Promise<void>;
};
export declare function startLocalCarr(options: { assets(request: Request): Promise<Response> }): Promise<LocalCarr>;
