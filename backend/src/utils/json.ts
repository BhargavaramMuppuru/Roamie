export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stripCodeFences(value: string): string {
  return value.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}
