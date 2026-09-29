import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import "./app/styles.css";
import { LanguageProvider } from "./i18n/language";
import { DialogActionsProvider } from "./components/DialogActions";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <DialogActionsProvider>
        <App />
      </DialogActionsProvider>
    </LanguageProvider>
  </React.StrictMode>,
);
