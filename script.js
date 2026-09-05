document.addEventListener("DOMContentLoaded", () => {
  const qrContainer = document.getElementById("qrcode");
  const qrLoading = document.getElementById("qr-loading");
  const shareLinkInput = document.getElementById("share-link");
  const copyBtn = document.getElementById("btn-copy");
  const statusPill = document.getElementById("status-pill");
  const connectBtn = document.getElementById("btn-connect");
  const targetPeerInput = document.getElementById("target-peer-id");

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
  let qrCodeInstance = null;

  const CHUNK_SIZE = 16 * 1024; // 16KB chunks for smooth WebRTC streaming

  // Format bytes
  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  // 1. Guaranteed Client-Side QR Generator
  function renderQRCode(url) {
    qrContainer.innerHTML = "";
    qrLoading.style.display = "none";
    qrCodeInstance = new QRCode(qrContainer, {
      text: url,
      width: 190,
      height: 190,
      colorDark: "#0d1117",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  // Check URL query param for existing room (e.g., ?join=PEER_ID)
  const urlParams = new URLSearchParams(window.location.search);
  const joinPeerId = urlParams.get("join");

  // 2. Initialize WebRTC Peer
  function initPeer() {
    qrLoading.style.display = "block";
    statusPill.textContent = "Connecting...";

    peer = new Peer({
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
        ],
      },
    });

    peer.on("open", (id) => {
      statusPill.textContent = "Ready";
      statusPill.className = "status-pill online";

      // Formulate joinable URL
      const currentUrl = window.location.origin + window.location.pathname;
      const connectionUrl = `${currentUrl}?join=${id}`;
      shareLinkInput.value = connectionUrl;

      // Render the QR code immediately once ID is established
      renderQRCode(connectionUrl);

      // If user joined with a link, auto-connect to the host
      if (joinPeerId) {
        setupConnection(peer.connect(joinPeerId));
      }
    });

    // Handle incoming connections from the second device
    peer.on("connection", (conn) => {
      setupConnection(conn);
    });

    peer.on("error", (err) => {
      console.error("PeerJS Error:", err);
      statusPill.textContent = "Reconnecting...";
      statusPill.className = "status-pill offline";
    });
  }

  // 3. Setup Connection Events
  function setupConnection(conn) {
    activeConn = conn;

    conn.on("open", () => {
      statusPill.textContent = "Connected";
      statusPill.className = "status-pill connected";
      if (selectedFiles.length > 0) sendBtn.disabled = false;
    });

    conn.on("close", () => {
      statusPill.textContent = "Ready";
      statusPill.className = "status-pill online";
      sendBtn.disabled = true;
      activeConn = null;
    });

    // Receive incoming data chunks
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
        addReceivedFile(blob, incomingFile.meta.name, incomingFile.meta.size);
      }
    });
  }

  // 4. Add Received File to List and Auto-Download
  function addReceivedFile(blob, name, size) {
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
  }

  // 5. Drag & Drop File Handling
  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });

  dropZone.addEventListener("drop", (e) => {
    const files = e.dataTransfer.files;
    if (files.length) handleFilesSelected(files);
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) handleFilesSelected(e.target.files);
  });

  function handleFilesSelected(files) {
    selectedFiles = Array.from(files);
    fileList.innerHTML = "";

    selectedFiles.forEach((file) => {
      const el = document.createElement("div");
      el.className = "file-item";
      el.innerHTML = `<span>📄 ${file.name}</span><span class="size">${formatBytes(file.size)}</span>`;
      fileList.appendChild(el);
    });

    if (activeConn && activeConn.open) {
      sendBtn.disabled = false;
    }
  }

  // 6. Send File Chunks
  sendBtn.addEventListener("click", async () => {
    if (!activeConn || !selectedFiles.length) return;

    sendBtn.disabled = true;
    progressContainer.classList.remove("hidden");

    for (const file of selectedFiles) {
      transferFilename.textContent = `Sending: ${file.name}`;

      // Send metadata
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

        // Small yield to prevent WebRTC data channel backpressure
        await new Promise((r) => setTimeout(r, 8));
      }

      activeConn.send({ type: "done" });
    }

    setTimeout(() => {
      progressContainer.classList.add("hidden");
      progressFill.style.width = "0%";
      sendBtn.disabled = false;
    }, 1000);
  });

  // 7. Manual Connect & Copy Helpers
  connectBtn.addEventListener("click", () => {
    const targetId = targetPeerInput.value.trim();
    if (targetId) {
      setupConnection(peer.connect(targetId));
    }
  });

  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
    });
  });

  // Start peer
  initPeer();
});