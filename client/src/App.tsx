import React from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { AppProvider, useAppState } from "./ui.js";
import { Dashboard } from "./views/Dashboard.js";
import { Novels } from "./views/Novels.js";
import { Editor } from "./views/Editor.js";
import { Assistant } from "./views/Assistant.js";
import { Characters } from "./views/Characters.js";
import { World } from "./views/World.js";
import { Memory } from "./views/Memory.js";
import { Timeline } from "./views/Timeline.js";
import { Continuity } from "./views/Continuity.js";
import { Settings } from "./views/Settings.js";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/novels", label: "My Novels" },
  { to: "/editor", label: "Chapter Editor" },
  { to: "/assistant", label: "AI Assistant" },
  { to: "/characters", label: "Characters" },
  { to: "/world", label: "Worldbuilding" },
  { to: "/memory", label: "Story Memory" },
  { to: "/timeline", label: "Timeline" },
  { to: "/continuity", label: "Continuity" },
  { to: "/settings", label: "Settings" },
];

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { prefs } = useAppState();
  return (
    <div className="flex h-full">
      <nav className="w-56 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col py-5">
        <div className="px-5 mb-6">
          <div className="font-serif text-xl text-loom-500">Loreloom</div>
          <div className="text-[11px] text-ink-400 mt-0.5">local writing studio</div>
        </div>
        <div className="flex-1 flex flex-col gap-0.5 px-3">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                `px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive ? "bg-ink-800 text-loom-500" : "text-ink-300 hover:bg-ink-850 hover:text-ink-200"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </div>
        <div className="px-5 pt-4 border-t border-ink-800 text-[11px] text-ink-400">Ollama · your machine · your words</div>
      </nav>
      <main className="flex-1 overflow-y-auto" style={prefs?.ui.focusMode ? { opacity: 0.92 } : undefined}>
        {children}
      </main>
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/novels" element={<Novels />} />
            <Route path="/editor" element={<Editor />} />
            <Route path="/assistant" element={<Assistant />} />
            <Route path="/characters" element={<Characters />} />
            <Route path="/world" element={<World />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/timeline" element={<Timeline />} />
            <Route path="/continuity" element={<Continuity />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </AppProvider>
  );
}
