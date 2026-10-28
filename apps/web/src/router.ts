import { useEffect, useState } from "react";

export function useRoute(): string[] {
  const parse = () => (location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean);
  const [parts, setParts] = useState(parse);
  useEffect(() => {
    const on = () => setParts(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export function navigate(path: string) {
  location.hash = path.startsWith("#") ? path : `#${path}`;
}
