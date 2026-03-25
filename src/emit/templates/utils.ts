// src/emit/templates/utils.ts

export function sanitizeK8sName(name: string): string {
  // Lowercase, replace non-alphanumeric with hyphens
  let sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  // Ensure it starts with a letter
  if (!/^[a-z]/.test(sanitized)) {
    sanitized = `b-${sanitized}`;
  }
  // Ensure it ends with an alphanumeric character
  sanitized = sanitized.replace(/-+$/, "");
  // Truncate to 63 characters (DNS-1035/1123 limit)
  return sanitized.slice(0, 63);
}
