document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const myNameDisplay = document.getElementById("my-name");
  const pinInput = document.getElementById("pin-input");
  const enterPinBtn = document.getElementById("btn-enter-pin");
  const randomPinBtn = document.getElementById("btn-random-pin");
  const shareLinkInput = document.getElementById("share-link");
  const copyLinkBtn = document.getElementById("btn-copy-link");
  const statusPill = document.getElementById("status-pill");
  const newWindowBtn = document.getElementById("btn-new-window");
  const connectedCountSpan = document.getElementById("connected-count");
  const devicesRoster = document.getElementById("devices-roster");

  const alertBox = document.getElementById("alert-box");
  const alertText = document.getElementById("alert-text");
  const closeAlertBtn = document.getElementById("btn-close-alert");
  const logBox = document.getElementById("log-box");
  const clearLogBtn = document.getElementById("btn-clear-log");

  const qrContainer = document.getElementById("qrcode");

  const startCallBtn = document.getElementById("btn-start-call");
  const endCallBtn = document.getElementById("btn-end-call");
  const toggleMicBtn = document.getElementById("btn-toggle-mic");
  const toggleCamBtn = document.getElementById("btn-toggle-cam");
  const recordBtn = document.getElementById("btn-record");
  const videoContainer = document.getElementById("video-container");
  const localVideo = document.getElementById("local-video");
  const remoteVideo = document.getElementById("remote-video");
  const recordBanner = document.getElementById("record-banner");

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const stagedFilesDiv = document.getElementById("staged-files");
  const sendFilesBtn = document.getElementById("btn-send-files");
  const progressContainer = document.getElementById("progress-container");
  const progressBar = document.getElementById("progress-bar");
  const transferName = document.getElementById("transfer-name");
  const transferPct = document.getElementById("transfer-pct");
  const transferStatusTag = document.getElementById("transfer-status-tag");

  const chatStream = document.getElementById("chat-stream");
  const chatInput = document.getElementById("chat-input");
  const sendChatBtn = document.getElementById("btn-send-chat");

  // State
  let myPeerId = null;
  let currentPin = null;
  let peer = null;
  let connections = new Map(); // peerId -> { conn, name }
  let selectedFiles = [];
  let fileInTransit = new Map(); // fileId -> state
  let localStream = null;
  let activeCall = null;
  let mediaRecorder = null;
  let recordedBlobs = [];

  const CHUNK_SIZE = 16384; // 16 KB

  // 1. Generate & Keep Cool Device Alias
  function getAssignedName() {
    let name = sessionStorage.getItem("dhurta_user_alias");
    if (!name) {
      const colors = ["Cyber", "Neon", "Solar", "Cosmic", "Emerald", "Ruby", "Shadow", "Amber"];
      const animals = ["Falcon", "Tiger", "Fox", "Wolf", "Hawk", "Eagle", "Cheetah", "Lynx"];
      name = `${colors[Math.floor(Math.random() * colors.length)]} ${animals[Math.floor(Math.random() * animals.length)]}`;
      sessionStorage.setItem("dhurta_user_alias", name);
    }
    return name;
  }
  const myName = getAssignedName();
  myNameDisplay.textContent = myName;

  // Logging & Alerts
  function log(msg, type = "default") {
    const row = document.createElement("div");
    row.className = type;
    row.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logBox.appendChild(row);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function showAlert(msg, isError = false) {
    alertText.textContent = msg;
    alertBox.className = isError ? "alert-box error" : "alert-box";
    alertBox.classList.remove("hidden");
    log(msg, isError ? "error" : "info");
  }

  closeAlertBtn.addEventListener("click", () => alertBox.classList.add("hidden"));
  clearLogBtn.addEventListener("click", () => (logBox.innerHTML = ""));

  function formatBytes(b) {
    if (b === 0) return "0 B";
    const k = 1024, s = ["B", "KB", "MB", "GB"], i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(1)) + " " + s[i];
  }

  // 2. Client-Side QR Generator
  function renderQR(url) {
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, {
      text: url,
      width: 150,
      height: 150,
      colorDark: "#090d14",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  // 3. Initialize Robust PeerJS Engine
  function initPeer(preferredPin = null, targetJoinId = null) {
    if (peer) peer.destroy();

    currentPin = preferredPin || Math.floor(1000 + Math.random() * 9000).toString();
    pinInput.value = currentPin;

    statusPill.textContent = "Connecting to broker...";
    statusPill.className = "status-pill online";

    // Use reliable server-assigned IDs to avoid broker conflicts
    peer = new Peer({
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun.cloudflare.com:3478" },
        ],
      },
    });

    peer.on("open", (id) => {
      myPeerId = id;
      log(`Peer broker connected. Unique ID: ${id.slice(0, 8)}...`, "success");
      statusPill.textContent = `Room ${currentPin} (Active)`;
      statusPill.className = "status-pill online";

      // Formulate precise direct pairing link
      const joinUrl = `${window.location.origin}${window.location.pathname}?pin=${currentPin}&join=${id}`;
      shareLinkInput.value = joinUrl;
      renderQR(joinUrl);

      updateRoster();

      // If opening as a targeted guest, auto-connect immediately
      if (targetJoinId) {
        log(`Auto-connecting to room host (${targetJoinId.slice(0, 8)})...`, "info");
        connectToPeer(targetJoinId);
      }
    });

    peer.on("connection", (conn) => {
      log(`Incoming handshake from peer!`, "info");
      bindDataChannel(conn);
    });

    peer.on("call", (call) => {
      handleIncomingCall(call);
    });

    peer.on("error", (err) => {
      if (err.type === "peer-unavailable") {
        showAlert("Host is not online yet. Keep this window open or use the QR code link.", true);
      } else {
        showAlert(`Network/PeerJS event: ${err.type}`, true);
      }
    });
  }

  // 4. Data Connection Handshake (Fixed Immediate Open Check)
  function connectToPeer(targetId) {
    const conn = peer.connect(targetId, { reliable: true });
    bindDataChannel(conn);
  }

  function bindDataChannel(conn) {
    const setup = () => {
      connections.set(conn.peer, { conn, name: "Remote Device" });

      statusPill.textContent = `Connected (Room ${currentPin})`;
      statusPill.className = "status-pill connected";

      // Announce identity
      conn.send({ type: "handshake", name: myName, pin: currentPin });
      updateRoster();
      log(`WebRTC channel open with peer.`, "success");
      showAlert(`Device connected to Room ${currentPin}!`, false);
    };

    // Fix: In PeerJS, conn.open may already be true on incoming connections
    if (conn.open) {
      setup();
    } else {
      conn.on("open", setup);
    }

    conn.on("close", () => {
      connections.delete(conn.peer);
      updateRoster();
      log(`Peer disconnected.`, "info");
      if (connections.size === 0) {
        statusPill.textContent = `Room ${currentPin} (Waiting)`;
        statusPill.className = "status-pill online";
      }
    });

    conn.on("data", (data) => {
      handleIncomingData(data, conn);
    });

    conn.on("error", (err) => {
      log(`DataChannel error: ${err.message}`, "error");
    });
  }

  function updateRoster() {
    devicesRoster.innerHTML = "";
    const count = connections.size + 1;
    connectedCountSpan.textContent = count;

    // Self
    const selfRow = document.createElement("div");
    selfRow.className = "device-card";
    selfRow.innerHTML = `<span><span class="dot"></span><strong>${myName}</strong> (You)</span><span style="color:#64748b">Active</span>`;
    devicesRoster.appendChild(selfRow);

    // Peers
    connections.forEach((device) => {
      const row = document.createElement("div");
      row.className = "device-card";
      row.innerHTML = `<span><span class="dot"></span>${device.name}</span><span style="color:#10b981">Connected</span>`;
      devicesRoster.appendChild(row);
    });
  }

  // 5. High-Reliability Data & Chunk Processing
  function arrayBufferToBase64(buf) {
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function base64ToArrayBuffer(b64) {
    const binary = window.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function handleIncomingData(data, conn) {
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return; }
    }

    if (data.type === "handshake") {
      if (connections.has(conn.peer)) {
        connections.get(conn.peer).name = data.name;
        updateRoster();
        appendSystemChat(`${data.name} joined the room.`);
      }
    } else if (data.type === "chat") {
      appendChatBubble(data.sender, data.text, false);
    } else if (data.type === "file_start") {
      fileInTransit.set(data.fileId, {
        meta: data,
        chunks: [],
        receivedChunks: 0,
      });
      progressContainer.classList.remove("hidden");
      transferName.textContent = `Receiving: ${data.name}`;
      transferStatusTag.textContent = "Receiving...";
    } else if (data.type === "file_chunk") {
      const record = fileInTransit.get(data.fileId);
      if (!record) return;

      record.chunks[data.index] = base64ToArrayBuffer(data.data);
      record.receivedChunks++;

      const pct = Math.min(100, Math.round((record.receivedChunks / record.meta.totalChunks) * 100));
      progressBar.style.width = `${pct}%`;
      transferPct.textContent = `${pct}%`;
    } else if (data.type === "file_finish") {
      const record = fileInTransit.get(data.fileId);
      if (!record) return;

      progressContainer.classList.add("hidden");
      progressBar.style.width = "0%";
      transferStatusTag.textContent = "Complete";

      const blob = new Blob(record.chunks, { type: record.meta.mime });
      displayAndDownloadFile(blob, record.meta.name, record.meta.mime, data.sender);
      fileInTransit.delete(data.fileId);
    }
  }

  function displayAndDownloadFile(blob, name, mime, sender) {
    const url = URL.createObjectURL(blob);

    // Auto-download file to recipient storage
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();

    // Render Preview in Chat Feed
    const wrap = document.createElement("div");
    wrap.className = "chat-bubble peer";
    wrap.innerHTML = `<div class="chat-sender">${sender} (Shared File)</div><div>📄 <strong>${name}</strong> (${formatBytes(blob.size)})</div>`;

    if (mime.startsWith("image/")) {
      wrap.innerHTML += `<div class="chat-media-preview"><img src="${url}" alt="${name}" /></div>`;
    } else if (mime.startsWith("video/")) {
      wrap.innerHTML += `<div class="chat-media-preview"><video src="${url}" controls></video></div>`;
    } else if (mime.startsWith("audio/")) {
      wrap.innerHTML += `<div class="chat-media-preview"><audio src="${url}" controls></audio></div>`;
    }

    wrap.innerHTML += `<a href="${url}" download="${name}" style="color:#60a5fa; text-decoration: underline; font-size:0.75rem; display:inline-block; margin-top:4px;">Download again</a>`;
    chatStream.appendChild(wrap);
    chatStream.scrollTop = chatStream.scrollHeight;

    log(`Received & saved file "${name}".`, "success");
  }

  // 6. Send File Logic with Safe Backpressure
  sendFilesBtn.addEventListener("click", async () => {
    if (!selectedFiles.length) {
      showAlert("Please drag & drop or select files first.", true);
      return;
    }

    if (connections.size === 0) {
      showAlert("No device connected yet! Staged files will be held until a device connects.", true);
      return;
    }

    sendFilesBtn.disabled = true;
    progressContainer.classList.remove("hidden");
    transferStatusTag.textContent = "Sending...";

    for (const file of selectedFiles) {
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      transferName.textContent = `Sending: ${file.name}`;

      // Broadcast metadata
      broadcast({
        type: "file_start",
        fileId,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        totalChunks,
        sender: myName,
      });

      // Slice and stream Base64 chunks safely
      for (let i = 0; i < totalChunks; i++) {
        const slice = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const buf = await slice.arrayBuffer();
        const base64Chunk = arrayBufferToBase64(buf);

        broadcast({
          type: "file_chunk",
          fileId,
          index: i,
          data: base64Chunk,
        });

        const pct = Math.min(100, Math.round(((i + 1) / totalChunks) * 100));
        progressBar.style.width = `${pct}%`;
        transferPct.textContent = `${pct}%`;

        // Wait to prevent WebRTC SCTP buffer overflow
        await new Promise((resolve) => setTimeout(resolve, 8));
      }

      broadcast({ type: "file_finish", fileId, sender: myName });

      // Notify local chat
      appendSentFileNotice(file);
      log(`Sent file: ${file.name}`, "success");
    }

    setTimeout(() => {
      progressContainer.classList.add("hidden");
      progressBar.style.width = "0%";
      selectedFiles = [];
      stagedFilesDiv.innerHTML = "";
      sendFilesBtn.disabled = false;
      transferStatusTag.textContent = "Sent";
    }, 600);
  });

  function broadcast(payload) {
    const str = JSON.stringify(payload);
    connections.forEach(({ conn }) => {
      if (conn && conn.open) {
        conn.send(str);
      }
    });
  }

  function appendSentFileNotice(file) {
    const b = document.createElement("div");
    b.className = "chat-bubble mine";
    b.innerHTML = `<div class="chat-sender">You</div><div>📤 Sent <strong>${file.name}</strong> (${formatBytes(file.size)})</div>`;
    chatStream.appendChild(b);
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  // 7. Drag & Drop File Handlers
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
    stagedFilesDiv.innerHTML = "";

    selectedFiles.forEach((f) => {
      const item = document.createElement("div");
      item.className = "staged-item";
      item.innerHTML = `<span>📄 ${f.name}</span><span style="color:#64748b">${formatBytes(f.size)}</span>`;
      stagedFilesDiv.appendChild(item);
    });

    transferStatusTag.textContent = `${selectedFiles.length} file(s) ready`;
    showAlert(`${selectedFiles.length} file(s) staged. Click 'Send Selected Files' to transmit.`, false);
  }

  // 8. Chat
  function appendChatBubble(sender, text, isMine) {
    const b = document.createElement("div");
    b.className = `chat-bubble ${isMine ? "mine" : "peer"}`;
    b.innerHTML = `<div class="chat-sender">${sender}</div><div>${text}</div>`;
    chatStream.appendChild(b);
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  function appendSystemChat(text) {
    const d = document.createElement("div");
    d.className = "chat-system-msg";
    d.textContent = text;
    chatStream.appendChild(d);
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    appendChatBubble(myName, text, true);
    broadcast({ type: "chat", sender: myName, text });
    chatInput.value = "";
  }

  sendChatBtn.addEventListener("click", sendChatMessage);
  chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });

  // 9. WebRTC Audio / Video Calls
  startCallBtn.addEventListener("click", async () => {
    if (connections.size === 0) {
      showAlert("Wait for another device to enter the room before starting a call.", true);
      return;
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      videoContainer.classList.remove("hidden");

      startCallBtn.classList.add("hidden");
      endCallBtn.classList.remove("hidden");
      toggleMicBtn.classList.remove("hidden");
      toggleCamBtn.classList.remove("hidden");

      // Call the connected peer
      const remotePeerId = connections.keys().next().value;
      activeCall = peer.call(remotePeerId, localStream);

      activeCall.on("stream", (remoteStream) => {
        remoteVideo.srcObject = remoteStream;
      });

      activeCall.on("close", endCall);
      log(`Calling remote peer...`, "info");
    } catch (e) {
      showAlert(`Camera/Microphone error: ${e.message}`, true);
    }
  });

  function handleIncomingCall(call) {
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then((stream) => {
        localStream = stream;
        localVideo.srcObject = stream;
        videoContainer.classList.remove("hidden");

        startCallBtn.classList.add("hidden");
        endCallBtn.classList.remove("hidden");
        toggleMicBtn.classList.remove("hidden");
        toggleCamBtn.classList.remove("hidden");

        call.answer(stream);
        activeCall = call;

        call.on("stream", (remoteStream) => {
          remoteVideo.srcObject = remoteStream;
        });

        call.on("close", endCall);
      })
      .catch((e) => showAlert(`Microphone/Camera permission error: ${e.message}`, true));
  }

  function endCall() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    videoContainer.classList.add("hidden");

    startCallBtn.classList.remove("hidden");
    endCallBtn.classList.add("hidden");
    toggleMicBtn.classList.add("hidden");
    toggleCamBtn.classList.add("hidden");
  }

  endCallBtn.addEventListener("click", () => {
    if (activeCall) activeCall.close();
    endCall();
  });

  toggleMicBtn.addEventListener("click", () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      toggleMicBtn.textContent = track.enabled ? "🎤 Mute" : "🔇 Unmute";
    }
  });

  toggleCamBtn.addEventListener("click", () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      toggleCamBtn.textContent = track.enabled ? "📷 Video Off" : "📷 Video On";
    }
  });

  // 10. Recording Session
  recordBtn.addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      recordBtn.textContent = "⏺ Record Session";
      recordBanner.classList.add("hidden");
      return;
    }

    try {
      let streamToRecord = localStream;
      if (!streamToRecord) {
        streamToRecord = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      }

      recordedBlobs = [];
      mediaRecorder = new MediaRecorder(streamToRecord, { mimeType: "video/webm" });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedBlobs.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedBlobs, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Dhurta-Record-${Date.now()}.webm`;
        a.click();
        log("Recorded video session saved and downloaded.", "success");
      };

      mediaRecorder.start();
      recordBtn.textContent = "⏹ Stop Recording";
      recordBanner.classList.remove("hidden");
      log("Session recording started...", "info");
    } catch (e) {
      showAlert(`Screen/Session recording failed: ${e.message}`, true);
    }
  });

  // 11. Room & Navigation Controls
  enterPinBtn.addEventListener("click", () => {
    const pin = pinInput.value.trim();
    if (!/^\d{4}$/.test(pin)) {
      showAlert("Please enter a 4-digit code (e.g. 4829).", true);
      return;
    }
    initPeer(pin);
  });

  randomPinBtn.addEventListener("click", () => {
    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    initPeer(pin);
  });

  newWindowBtn.addEventListener("click", () => {
    if (shareLinkInput.value.startsWith("http")) {
      window.open(shareLinkInput.value, "_blank", "width=920,height=820");
    }
  });

  copyLinkBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
      copyLinkBtn.textContent = "Copied!";
      setTimeout(() => (copyLinkBtn.textContent = "Copy Link"), 2000);
    });
  });

  // 12. Auto-Bootstrap from URL params (?pin=XXXX&join=TARGET_PEER_ID)
  const urlParams = new URLSearchParams(window.location.search);
  const paramPin = urlParams.get("pin");
  const paramJoin = urlParams.get("join");

  initPeer(paramPin, paramJoin);
});