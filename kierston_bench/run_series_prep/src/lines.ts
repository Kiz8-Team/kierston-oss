/** Call `line` for every non-blank line of a stream as it arrives, and return the whole text. */
export async function eachLine(stream: ReadableStream<Uint8Array>, line: (text: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let text = "", pending = "";
  for await (const chunk of stream) {
    const part = decoder.decode(chunk, { stream: true });
    text += part;
    const lines = (pending + part).split("\n");
    pending = lines.pop()!;
    for (const each of lines) if (each.trim()) line(each);
  }
  if (pending.trim()) line(pending);
  return text;
}
