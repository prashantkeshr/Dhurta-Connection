document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const pinInput = document.getElementById("pin-input");
  const joinPinBtn = document.getElementById("btn-join-pin");
  const randomPinBtn = document.getElementById("btn-random-pin");
  const currentRoomTag = document.getElementById("current-room-tag");
  const activePinDisplay = document.getElementById("active-pin-display");

  const qrContainer = document.getElementById("qrcode");
  const qrPlaceholder = document.getElementById("qr-placeholder");
  const shareLinkInput = document.getElementById("share-link");
  const copyBtn = document.getElementById("btn-copy");
  const statusPill = document.getElementById("status-pill");

  const errorBanner = document.getElementById("error-banner");
  const errorMessage = document.getElementById("error-message");
  const closeErrorBtn = document.getElementById("btn-close-error");

  const selfTestBtn = document.getElementById("btn-self-test");
  const diagPanel = document.getElementById("diag-panel");
  const diagList = document.getElementById("diag-list");
  const closeDiagBtn = document.getElementById("btn-close-diag");
  const logOutput = document.getElementById("log-output");

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const fileList = document.getElementById("file-list");
  const sendBtn = document.getElementById("btn-send");
  const progressContainer = document.getElementById("progress-container");
  const progressFill = document.getElementById("progress-fill");
  const transferFilename = document.getElementById("transfer-filename");
  const transferPercent = document.getElementById("transfer-percent");
  const receivedList = document.getElementById("received-list");

  let peer = null;
  let activeConn = null;
  let selectedFiles = [];
  let currentPin = null;
  const CHUNK_SIZE = 16 * 1024; // 16KB

  // Log Helper & On-screen Alerts
  function log(msg, type = "default") {
    const time = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    line.textContent = `[${time}] ${msg}`;
    logOutput.appendChild(line);
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    errorBanner.className = "alert-banner";
    errorBanner.classList.remove("hidden");
    log(`ERROR: ${msg}`, "error");
  }

  function showInfo(msg) {
    errorMessage.textContent = msg;
    errorBanner.className = "alert-banner info";
    errorBanner.classList.remove("hidden");
    log(msg, "info");
  }

  closeErrorBtn.addEventListener("click", () => errorBanner.classList.add("hidden"));
  closeDiagBtn.addEventListener("click", () => diagPanel.classList.add("hidden"));

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  // QR Code Renderer
  function renderQR(url) {
    qrPlaceholder.style.display = "none";
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, {
      text: url,
      width: 180,
      height: 180,
      colorDark: "#0d1117",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  // --- 4-Digit Room Manager ---
  function enterRoom(pin) {
    if (!/^\d{4}$/.test(pin)) {
      showError("Please enter a valid 4-digit number (e.g. 4829).");
      return;
    }

    currentPin = pin;
    activePinDisplay.textContent = pin;
    currentRoomTag.classList.remove("hidden");

    const hostPeerId = `dhurta-room-${pin}`;
    const joinUrl = `${window.location.origin}${window.location.pathname}?pin=${pin}`;
    shareLinkInput.value = joinUrl;
    renderQR(joinUrl);

    if (peer) {
      peer.destroy();
    }

    log(`Attempting to claim or join Room #${pin}...`, "info");
    statusPill.textContent = "Connecting...";
    statusPill.className = "status-pill online";

    // Attempt 1: Try to claim the room as the primary host
    peer = new Peer(hostPeerId, {
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
        ],
      },
    });

    peer.on("open", (id) => {
      log(`Room ${pin} created! Waiting for device 2 to enter PIN...`, "success");
      statusPill.textContent = `Room ${pin} Ready`;
      statusPill.className = "status-pill online";
    });

    peer.on("connection", (conn) => {
      log(`Incoming connection established in room ${pin}!`, "success");
      setupDataConnection(conn);
    });

    peer.on("error", (err) => {
      // Room already exists: join as a guest peer!
      if (err.type === "unavailable-id") {
        log(`Room ${pin} already exists on another device. Joining as guest...`, "info");
        joinAsGuest(hostPeerId);
      } else {
        showError(`Signaling error: ${err.message || err.type}`);
      }
    });
  }

  function joinAsGuest(targetHostId) {
    if (peer) peer.destroy();

    // Create random guest peer and connect to the room host
    peer = new Peer();
    peer.on("open", (guestId) => {
      log(`Guest initiated. Connecting to Room Host (${targetHostId})...`, "info");
      const conn = peer.connect(targetHostId);
      setupDataConnection(conn);
    });

    peer.on("error", (err) => {
      showError(`Guest connection failed: ${err.message || err.type}`);
    });
  }

  function setupDataConnection(conn) {
    activeConn = conn;

    conn.on("open", () => {
      statusPill.textContent = `Connected (Room ${currentPin})`;
      statusPill.className = "status-pill connected";
      showInfo(`Devices paired successfully in Room ${currentPin}!`);
      if (selectedFiles.length > 0) sendBtn.disabled = false;
    });

    conn.on("close", () => {
      statusPill.textContent = `Room ${currentPin} (Waiting)`;
      statusPill.className = "status-pill online";
      showError("Peer disconnected from the room.");
      sendBtn.disabled = true;
      activeConn = null;
    });

    // Chunk Receiver
    let incomingFile = { meta: null, chunks: [], receivedBytes: 0 };

    conn.on("data", (data) => {
      if (data.type === "meta") {
        incomingFile = { meta: data.meta, chunks: [], receivedBytes: 0 };
        progressContainer.classList.remove("hidden");
        transferFilename.textContent = `Receiving: ${data.meta.name}`;
      } else if (data.type === "chunk") {
        incomingFile.chunks.push(data.chunk);
        incomingFile.receivedBytes += data.chunk.byteLength || data.chunk.size || CHUNK_SIZE;

        const percent = Math.min(100, Math.round((incomingFile.receivedBytes / incomingFile.meta.size) * 100));
        progressFill.style.width = `${percent}%`;
        transferPercent.textContent = `${percent}%`;
      } else if (data.type === "done") {
        progressContainer.classList.add("hidden");
        progressFill.style.width = "0%";

        const blob = new Blob(incomingFile.chunks, { type: incomingFile.meta.type });
        renderDownloadedFile(blob, incomingFile.meta.name, incomingFile.meta.size);
      }
    });
  }

  function renderDownloadedFile(blob, name, size) {
    const url = URL.createObjectURL(blob);
    const emptyState = receivedList.querySelector(".empty-state");
    if (emptyState) emptyState.remove();

    const item = document.createElement("div");
    item.className = "received-item";
    item.innerHTML = `
      <div>
        <strong>${name}</strong>
        <span style="color:#8b949e; margin-left: 8px;">(${formatBytes(size)})</span>
      </div>
      <a href="${url}" download="${name}">Save</a>
    `;
    receivedList.prepend(item);

    // Trigger auto-download
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    log(`File "${name}" (${formatBytes(size)}) received and downloaded.`, "success");
  }

  // --- Drag & Drop Operations ---
  ["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });

  dropZone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) handleFiles(e.target.files);
  });

  function handleFiles(files) {
    selectedFiles = Array.from(files);
    fileList.innerHTML = "";

    selectedFiles.forEach((file) => {
      const el = document.createElement("div");
      el.className = "file-item";
      el.innerHTML = `<span>📄 ${file.name}</span><span style="color:#8b949e">${formatBytes(file.size)}</span>`;
      fileList.appendChild(el);
    });

    if (activeConn && activeConn.open) {
      sendBtn.disabled = false;
    } else {
      showInfo("Files queued. Connect another device with the 4-digit PIN to send.");
    }
  }

  // --- Send Files ---
  sendBtn.addEventListener("click", async () => {
    if (!activeConn || !selectedFiles.length) return;

    sendBtn.disabled = true;
    progressContainer.classList.remove("hidden");

    for (const file of selectedFiles) {
      transferFilename.textContent = `Sending: ${file.name}`;
      activeConn.send({
        type: "meta",
        meta: { name: file.name, size: file.size, type: file.type },
      });

      let offset = 0;
      while (offset < file.size) {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();

        activeConn.send({
          type: "chunk",
          chunk: buffer,
        });

        offset += CHUNK_SIZE;
        const percent = Math.min(100, Math.round((offset / file.size) * 100));
        progressFill.style.width = `${percent}%`;
        transferPercent.textContent = `${percent}%`;

        // Backpressure yield
        await new Promise((r) => setTimeout(r, 8));
      }

      activeConn.send({ type: "done" });
      log(`Sent: ${file.name}`, "success");
    }

    setTimeout(() => {
      progressContainer.classList.add("hidden");
      progressFill.style.width = "0%";
      sendBtn.disabled = false;
    }, 1000);
  });

  // --- Button & PIN Handlers ---
  joinPinBtn.addEventListener("click", () => enterRoom(pinInput.value.trim()));

  randomPinBtn.addEventListener("click", () => {
    const random = Math.floor(1000 + Math.random() * 9000).toString();
    pinInput.value = random;
    enterRoom(random);
  });

  copyBtn.addEventListener("click", () => {
    if (!shareLinkInput.value.startsWith("http")) {
      showError("Please enter a 4-digit room first.");
      return;
    }
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
    });
  });

  // --- Built-in Diagnostic Self-Test ---
  selfTestBtn.addEventListener("click", async () => {
    diagPanel.classList.remove("hidden");
    diagList.innerHTML = "<li>Testing browser WebRTC support...</li>";

    // Test 1: Browser WebRTC
    const rtcSupported = !!(window.RTCPeerConnection && window.RTCDataChannel);
    diagList.innerHTML = `<li>WebRTC Support: ${rtcSupported ? "✅ Supported" : "❌ Not Supported"}</li>`;

    // Test 2: STUN Server Candidates
    diagList.innerHTML += "<li>Testing STUN / ICE candidate generation...</li>";
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.createDataChannel("test");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const icePass = await new Promise((resolve) => {
        pc.onicecandidate = (e) => {
          if (e.candidate) resolve(true);
        };
        setTimeout(() => resolve(false), 4000);
      });

      pc.close();
      diagList.innerHTML += `<li>STUN Server (Google): ${icePass ? "✅ Reached" : "⚠️ Warning: STUN Slow or Blocked"}</li>`;
    } catch (e) {
      diagList.innerHTML += `<li style="color:#f85149">STUN Test Failed: ${e.message}</li>`;
    }

    // Test 3: PeerJS Signaling
    diagList.innerHTML += "<li>Testing PeerJS Cloud Signaling...</li>";
    try {
      const testPeer = new Peer();
      testPeer.on("open", (id) => {
        diagList.innerHTML += `<li>PeerJS Cloud Signaling: ✅ Working (Assigned ID: ${id.slice(0, 8)}...)</li>`;
        testPeer.destroy();
      });
      testPeer.on("error", (err) => {
        diagList.innerHTML += `<li style="color:#f85149">PeerJS Signaling Error: ${err.type}</li>`;
      });
    } catch (e) {
      diagList.innerHTML += `<li style="color:#f85149">PeerJS Init Failed: ${e.message}</li>`;
    }
  });

  // Auto-fill from URL query param (?pin=4829)
  const urlParams = new URLSearchParams(window.location.search);
  const pinFromUrl = urlParams.get("pin");
  if (pinFromUrl && /^\d{4}$/.test(pinFromUrl)) {
    pinInput.value = pinFromUrl;
    enterRoom(pinFromUrl);
  } else {
    // Generate a default 4-digit code on load
    const defaultPin = Math.floor(1000 + Math.random() * 9000).toString();
    pinInput.value = defaultPin;
    enterRoom(defaultPin);
  }
});