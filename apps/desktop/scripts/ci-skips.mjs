export default async function* reportSkips(source) {
  for await (const { type, data } of source) {
    if (type === "test:pass" && data.skip) {
      yield JSON.stringify({
        type: "skip",
        name: data.name,
        file: data.file,
        line: data.line,
        reason:
          typeof data.skip === "string"
            ? data.skip
            : "Explicit skip without a reason. See the recorded source location.",
      }) + "\n";
    }
    if (type === "test:summary") {
      yield JSON.stringify({ type: "summary", ...data }) + "\n";
    }
  }
}
