import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Preferences } from "./api.js";

// ------------------------------ primitives ---------------------------------

export const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "subtle" }> = ({
  variant = "ghost",
  className = "",
  children,
  ...rest
}) => {
  const styles: Record<string, string> = {
    primary: "bg-loom-500 text-ink-950 hover:bg-loom-600 font-medium",
    ghost: "border border-ink-700 text-ink-200 hover:border-loom-500 hover:text-loom-500",
    danger: "border border-red-900/60 text-red-300 hover:bg-red-950/40",
    subtle: "text-ink-400 hover:text-ink-200",
  };
  return (
    <button
      {...rest}
      className={`px-3 py-1.5 rounded-md text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
};

export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className = "", ...rest }) => (
  <input
    {...rest}
    className={`bg-ink-850 border border-ink-700 rounded-md px-3 py-2 text-sm text-ink-200 placeholder:text-ink-700 focus:outline-none focus:border-loom-600 ${className}`}
  />
);

export const TextArea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({ className = "", ...rest }) => (
  <textarea
    {...rest}
    className={`bg-ink-850 border border-ink-700 rounded-md px-3 py-2 text-sm text-ink-200 placeholder:text-ink-700 focus:outline-none focus:border-loom-600 ${className}`}
  />
);

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({ className = "", children, ...rest }) => (
  <select
    {...rest}
    className={`bg-ink-850 border border-ink-700 rounded-md px-2 py-2 text-sm text-ink-200 focus:outline-none focus:border-loom-600 ${className}`}
  >
    {children}
  </select>
);

export const Label: React.FC<{ children: ReactNode }> = ({ children }) => (
  <label className="block text-xs uppercase tracking-wider text-ink-400 mb-1">{children}</label>
);

export const Card: React.FC<{ children: ReactNode; className?: string; onClick?: () => void }> = ({
  children,
  className = "",
  onClick,
}) => (
  <div onClick={onClick} className={`bg-ink-900 border border-ink-800 rounded-xl ${onClick ? "cursor-pointer " : ""}${className}`}>
    {children}
  </div>
);

export const Modal: React.FC<{ open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }> = ({
  open,
  onClose,
  title,
  children,
  wide,
}) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 overflow-y-auto" onMouseDown={onClose}>
      <div
        className={`bg-ink-900 border border-ink-750 rounded-xl mt-12 w-full ${wide ? "max-w-3xl" : "max-w-lg"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-ink-800">
          <h3 className="font-serif text-loom-500">{title}</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-200 text-lg leading-none">
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
};

export const Empty: React.FC<{ title: string; children?: ReactNode }> = ({ title, children }) => (
  <div className="text-center py-20 px-6">
    <div className="text-loom-500 text-4xl mb-4">✒</div>
    <h2 className="font-serif text-xl text-ink-300 mb-2">{title}</h2>
    <p className="text-ink-400 text-sm max-w-md mx-auto">{children}</p>
  </div>
);

export const Spinner: React.FC = () => (
  <span className="inline-block w-3.5 h-3.5 border-2 border-loom-500 border-t-transparent rounded-full animate-spin" />
);

export const Tag: React.FC<{ children: ReactNode; tone?: "gold" | "green" | "amber" | "red" | "blue" }> = ({ children, tone = "gold" }) => {
  const tones: Record<string, string> = {
    gold: "bg-loom-500/15 text-loom-500 border-loom-600/40",
    green: "bg-emerald-500/15 text-emerald-300 border-emerald-700/40",
    amber: "bg-amber-500/15 text-amber-300 border-amber-700/40",
    red: "bg-red-500/15 text-red-300 border-red-700/40",
    blue: "bg-sky-500/15 text-sky-300 border-sky-700/40",
  };
  return <span className={`inline-flex px-2 py-0.5 rounded text-[11px] border ${tones[tone]}`}>{children}</span>;
};

// ------------------------------ app context --------------------------------

interface AppState {
  prefs: Preferences | null;
  reloadPrefs: () => void;
  activeNovelId: number | null;
  setActiveNovel: (id: number | null) => void;
}

const AppCtx = createContext<AppState>({
  prefs: null,
  reloadPrefs: () => {},
  activeNovelId: null,
  setActiveNovel: () => {},
});

export const useAppState = () => useContext(AppCtx);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [activeNovelId, setActiveNovel] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem("loreloom.novel"));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });

  const load = () =>
    api
      .get<Preferences>("/preferences")
      .then(setPrefs)
      .catch(() => setPrefs(null));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (activeNovelId != null) localStorage.setItem("loreloom.novel", String(activeNovelId));
  }, [activeNovelId]);

  // CSS custom properties for the editor surface
  useEffect(() => {
    if (!prefs) return;
    document.documentElement.style.setProperty("--editor-font-size", `${prefs.ui.fontSize}px`);
    document.documentElement.style.setProperty("--editor-line-height", String(prefs.ui.lineHeight));
  }, [prefs]);

  return <AppCtx.Provider value={{ prefs, reloadPrefs: load, activeNovelId, setActiveNovel }}>{children}</AppCtx.Provider>;
};

export const useActiveNovel = (): number | null => useAppState().activeNovelId;
