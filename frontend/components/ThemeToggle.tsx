"use client";

import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const stored = (typeof window !== "undefined" && localStorage.getItem("visiyon_theme")) as "dark" | "light" | null;
    setTheme(stored || "dark");
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("visiyon_theme", next);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(next);
  }

  return (
    <button
      onClick={toggle}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="p-2 rounded-lg border border-visiyon-border text-visiyon-text-2 hover:text-visiyon-text hover:border-visiyon-text transition-colors"
    >
      {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
