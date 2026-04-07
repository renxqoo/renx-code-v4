export async function* readSseEvents(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<{ event?: string; data: string }> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx === -1) break;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        const t = line.trimEnd();
        if (!t || t.startsWith(":")) continue;
        if (t.startsWith("event:")) event = t.slice(6).trim();
        else if (t.startsWith("data:"))
          dataLines.push(t.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      yield { event, data: dataLines.join("\n") };
    }
  }
}
