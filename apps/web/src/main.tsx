import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

// Invite links are plain paths (/invite/<token>) so they survive email clients; map to the hash router.
const invite = location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
if (invite) history.replaceState(null, "", `/#/invite/${invite[1]}`);

createRoot(document.getElementById("root")!).render(<App />);
