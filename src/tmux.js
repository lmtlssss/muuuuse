const { execFileSync } = require("node:child_process");
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

function runTmux(args) {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

function insideTmux() {
  return Boolean(process.env.TMUX && process.env.TMUX_PANE);
}

function getPaneInfo(target = process.env.TMUX_PANE) {
  if (!target) {
    return null;
  }

  try {
    const output = runTmux([
      "display-message",
      "-p",
      "-t",
      target,
      "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_pid}",
    ]).trim();

    if (!output) {
      return null;
    }

    const [sessionName = "", windowIndex = "", windowName = "", paneId = "", currentPath = "", panePid = ""] =
      output.split("\t");

    return {
      sessionName,
      windowIndex: Number.parseInt(windowIndex, 10),
      windowName,
      paneId,
      currentPath,
      panePid: Number.parseInt(panePid, 10),
    };
  } catch (error) {
    return null;
  }
}

function paneExists(paneId) {
  if (!paneId) {
    return false;
  }

  try {
    const output = runTmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]).trim();
    return output.length > 0;
  } catch (error) {
    return false;
  }
}

function setPaneTitle(paneId, title) {
  try {
    runTmux(["select-pane", "-t", paneId, "-T", title]);
    return true;
  } catch (error) {
    return false;
  }
}

function sendLiteral(paneId, text) {
  const chunkSize = 800;
  for (let start = 0; start < text.length; start += chunkSize) {
    const chunk = text.slice(start, start + chunkSize);
    if (chunk.length > 0) {
      runTmux(["send-keys", "-t", paneId, "-l", chunk]);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

function sendTextAndEnter(paneId, text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0) {
      sendLiteral(paneId, line);
      sleepSync(120);
    }

    if (index < lines.length - 1) {
      runTmux(["send-keys", "-t", paneId, "Enter"]);
    }
  }

  sleepSync(120);
  runTmux(["send-keys", "-t", paneId, "Enter"]);
}

function capturePaneText(paneId, lines = 220) {
  try {
    return runTmux(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", paneId]);
  } catch (error) {
    return "";
  }
}

function getPaneChildProcesses(paneId) {
  const info = getPaneInfo(paneId);
  if (!info || !Number.isInteger(info.panePid)) {
    return [];
  }

  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,etimes=,command="], {
      encoding: "utf8",
    });

    const processes = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) {
          return null;
        }

        return {
          pid: Number.parseInt(match[1], 10),
          ppid: Number.parseInt(match[2], 10),
          elapsedSeconds: Number.parseInt(match[3], 10),
          args: match[4],
        };
      })
      .filter((entry) => entry !== null);

    const descendants = [];
    const queue = [info.panePid];
    const seen = new Set(queue);

    while (queue.length > 0) {
      const parentPid = queue.shift();
      for (const process of processes) {
        if (process.ppid !== parentPid || seen.has(process.pid)) {
          continue;
        }
        seen.add(process.pid);
        queue.push(process.pid);
        descendants.push(process);
      }
    }

    return descendants.sort((left, right) => left.elapsedSeconds - right.elapsedSeconds);
  } catch (error) {
    return [];
  }
}

module.exports = {
  capturePaneText,
  getPaneChildProcesses,
  getPaneInfo,
  insideTmux,
  paneExists,
  sendTextAndEnter,
  setPaneTitle,
};
