// My plugins' old panel (docs/ARCHITECTURE.md › One place for each plugin). Since 0.2.0 My plugins is part of layr:
// each plugin's history, versions, updates and sharing are on its page in the Plugins list, drawn by the app itself.
// Old saved layouts may still have this tab: it opens the Plugins list at once, and offers a button to do it again.
const PLUGINS = "layr://layr/plugins";

async function openPlugins() {
  const error = document.getElementById("error");
  try {
    await window.layr.links.open(PLUGINS);
    error.hidden = true;
  } catch (e) {
    error.textContent = `Couldn't open the Plugins list: ${e?.message ?? e}`;
    error.hidden = false;
  }
}

document.getElementById("open").addEventListener("click", () => void openPlugins());
void openPlugins();
