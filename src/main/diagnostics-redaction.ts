const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\[^\r\n"'<>|]+/g;
const API_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const URL_WITH_OPTIONAL_QUERY = /\bhttps?:\/\/[^\s"'<>]+/g;
const KNOWN_FILE_PATH =
  /^(.*?\.(?:asar|bin|dll|exe|gif|ico|jpe?g|js|json|log|m4v|md|mov|mp4|msi|pak|png|pth|py|ts|tsx|txt|webm|webp|zip|7z))(.*)$/i;

export function redactDiagnosticsText(text: string): string {
  return text
    .replace(API_KEY, "sk-***")
    .replace(URL_WITH_OPTIONAL_QUERY, redactUrlQuery)
    .replace(WINDOWS_ABSOLUTE_PATH, (value) => {
      const { pathText, suffix } = splitWindowsPathTrailingText(value);
      const basename = pathText.split("\\").filter(Boolean).pop() ?? "";
      return `${basename ? `[本地路径]\\${basename}` : "[本地路径]"}${suffix}`;
    });
}

function redactUrlQuery(value: string): string {
  const { urlText, suffix } = splitTrailingPunctuation(value);
  try {
    const url = new URL(urlText);
    if (!url.search && !url.hash) return value;
    return `${url.origin}${url.pathname}?...${suffix}`;
  } catch {
    return value;
  }
}

function splitTrailingPunctuation(value: string): { urlText: string; suffix: string } {
  const match = value.match(/^(.*?)([),.;，。]*)$/);
  return { urlText: match?.[1] ?? value, suffix: match?.[2] ?? "" };
}

function splitWindowsPathTrailingText(value: string): { pathText: string; suffix: string } {
  const normalized = value.trimEnd();
  const trailingWhitespace = value.slice(normalized.length);
  const match = normalized.match(KNOWN_FILE_PATH);
  if (match) {
    return { pathText: match[1] ?? normalized, suffix: `${match[2] ?? ""}${trailingWhitespace}` };
  }
  return { pathText: normalized, suffix: trailingWhitespace };
}
