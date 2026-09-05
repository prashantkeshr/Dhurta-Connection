document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const myNameDisplay = document.getElementById("my-assigned-name");
  const pinInput = document.getElementById("pin-input");
  const joinRoomBtn = document.getElementById("btn-join-room");
  const randomRoomBtn = document.getElementById("btn-random-room");
  const shareLinkInput = document.getElementById("share-link");
  const copyLinkBtn = document.getElementById("btn-copy-link");
  const statusPill = document.getElementById("status-pill");
  const openNewWindowBtn = document.getElementById("btn-open-new-window");
  const deviceCountSpan = document.getElementById("device-count");
  const deviceList = document.getElementById("device-list");

  // Alert & Diagnostic Elements
  const alertBanner = document.getElementById("alert-banner");
  const alertMessage = document.getElementById("alert-message");
  const closeAlertBtn = document.getElementById("btn-close-alert");
  const selfTestBtn = document.getElementById("btn-self-test");
  const diagPanel = document.getElementById("diag-panel");
  const diagList = document.getElementById("diag-list");
  const closeDiagBtn = document.getElementById("btn-close-diag");
  const logConsole = document.getElementById("log-console");

  // QR Elements
  const qrContainer = document.getElementById("qrcode");
  const qrHint = document.getElementById("qr-hint");

  // Call & Record Elements
  const startCallBtn = document.getElementById("btn-start-call");
  const endCallBtn = document.getElementById("btn-end-call");
  const toggleMicBtn = document.getElementById("btn-toggle-mic");
  const toggleCamBtn = document.getElementById("btn-toggle-cam");
  const recordCallBtn = document.getElementById("btn-record-call");
  const videoContainer = document.getElementById("video-container");
  const localVideo = document.getElementById("local-video");
  const remoteVideo = document.getElementById("remote-video");
  const recordIndicator = document.getElementById("record-indicator");

  // File Transfer Elements
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const selectedFilesList = document.getElementById("selected-files-list");
  const sendFilesBtn = document.getElementById("btn-send-files");
  const progressWrapper = document.getElementById("progress-wrapper");
  const progressBar = document.getElementById("progress-bar");
  const transferFileTitle = document.getElementById("transfer-file-title");
  const transferFilePercent = document.getElementById("transfer-file-percent");

  // Chat Elements
  const chatMessages = document.getElementById("chat-messages");
  const chatText = document.getElementById("chat-text");
  const sendChatBtn = document.getElementById("btn-send-chat");

  // State
  let peer = null;
  let activeConnections = new Map(); // peerId -> DataConnection
  let currentCall = null;
  let localStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let currentPin = null;
  let selectedFiles = [];
  let receivingFiles = new Map(); // fileId -> state
  const CHUNK_SIZE = 16384; // 16 KB

  // 1. Generate & Persist Assigned Name
  function getAssignedName() {
    let storedName = sessionStorage.getItem("dhurta_assigned_name");
    if (!storedName) {
      const adjectives = ["Neon", "Cyber", "Cosmic", "Solar", "Amber", "Ruby", "Shadow", "Emerald", "Frost", "Golden"];
      const animals = ["Falcon", "Fox", "Tiger", "Hawk", "Wolf", "Lynx", "Eagle", "Dolphin", "Panda", "Cheetah"];
      storedName = `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${animals[Math.floor(Math.random() * animals.length)]}`;
      sessionStorage.setItem("dhurta_assigned_name", storedName);
    }
    return storedName;
  }
  const myName = getAssignedName();
  myNameDisplay.textContent = myName;

  // Logging & Alerts
  function log(msg, type = "default") {
    const time = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    line.textContent = `[${time}] ${msg}`;
    logConsole.appendChild(line);
    logConsole.scrollTop = logConsole.scrollHeight;
  }

  function showAlert(msg, isError = true) {
    alertMessage.textContent = msg;
    alertBanner.className = isError ? "alert-banner" : "alert-banner info";
    alertBanner.classList.remove("hidden");
    log(msg, isError ? "error" : "info");
  }

  closeAlertBtn.addEventListener("click", () => alertBanner.classList.add("hidden"));
  closeDiagBtn.addEventListener("click", () => diagPanel.classList.add("hidden"));

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  // 2. Client-Side QR Generator
  function renderQR(url) {
    qrHint.style.display = "none";
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, {
      text: url,
      width: 150,
      height: 150,
      colorDark: "#090d13",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  // 3. 4-Digit Room Orchestration
  function enterRoom(pin) {
    if (!/^\d{4}$/.test(pin)) {
      showAlert("Please enter a valid 4-digit number (e.g. 4829).");
      return;
    }

    currentPin = pin;
    pinInput.value = pin;
    const currentUrl = `${window.location.origin}${window.location.pathname}?pin=${pin}`;
    shareLinkInput.value = currentUrl;
    renderQR(currentUrl);

    if (peer) peer.destroy();

    statusPill.textContent = `Entering Room ${pin}...`;
    statusPill.className = "status-pill online";
    log(`Connecting to 4-Digit Room: ${pin}`, "info");

    const hostPeerId = `dhurta-v3-room-${pin}`;

    // Attempt to register as room host
    peer = new Peer(hostPeerId, {
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
        ],
      },
    });

    peer.on("open", () => {
      log(`Room ${pin} created! You are the Host.`, "success");
      statusPill.textContent = `Room ${pin} (Host)`;
      statusPill.className = "status-pill online";
      updateDeviceRoster();
    });

    peer.on("connection", (conn) => {
      setupDataChannel(conn);
    });

    peer.on("call", (call) => {
      handleIncomingCall(call);
    });

    peer.on("error", (err) => {
      if (err.type === "unavailable-id") {
        // Room host exists; connect as a guest!
        log(`Room ${pin} exists on another device. Joining as Guest...`, "info");
        joinAsGuest(hostPeerId);
      } else {
        showAlert(`PeerJS Error: ${err.type}`);
      }
    });
  }

  function joinAsGuest(hostPeerId) {
    if (peer) peer.destroy();

    peer = new Peer({
      config: {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      },
    });

    peer.on("open", () => {
      log(`Guest online. Connecting to Room Host...`, "info");
      const conn = peer.connect(hostPeerId);
      setupDataChannel(conn);
    });

    peer.on("call", (call) => {
      handleIncomingCall(call);
    });

    peer.on("error", (err) => {
      showAlert(`Guest connection error: ${err.type}`);
    });
  }

  // 4. Data Channel & Mesh Setup
  function setupDataChannel(conn) {
    conn.on("open", () => {
      activeConnections.set(conn.peer, { conn, name: "Remote Device" });

      statusPill.textContent = `Connected (Room ${currentPin})`;
      statusPill.className = "status-pill connected";

      // Handshake: exchange assigned names
      conn.send({ type: "name_announcement", name: myName });

      if (selectedFiles.length > 0) sendFilesBtn.disabled = false;
      updateDeviceRoster();
    });

    conn.on("close", () => {
      activeConnections.delete(conn.peer);
      log(`Device disconnected.`, "info");
      updateDeviceRoster();

      if (activeConnections.size === 0) {
        statusPill.textContent = `Room ${currentPin} (Waiting)`;
        statusPill.className = "status-pill online";
        sendFilesBtn.disabled = true;
      }
    });

    conn.on("data", (payload) => {
      handleIncomingData(payload, conn);
    });
  }

  function updateDeviceRoster() {
    deviceList.innerHTML = "";
    const totalDevices = activeConnections.size + 1; // peers + self
    deviceCountSpan.textContent = totalDevices;

    // Self item
    const selfEl = document.createElement("div");
    selfEl.className = "device-item";
    selfEl.innerHTML = `<span><span class="indicator"></span><strong>${myName}</strong> (You)</span><span style="color:#64748b">Host/Self</span>`;
    deviceList.appendChild(selfEl);

    // Remote peers
    activeConnections.forEach((info) => {
      const el = document.createElement("div");
      el.className = "device-item";
      el.innerHTML = `<span><span class="indicator"></span>${info.name}</span><span style="color:#10b981">Active</span>`;
      deviceList.appendChild(el);
    });
  }

  // 5. High-Reliability File Transfer & Media Handling
  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Incoming Data Dispatcher
  function handleIncomingData(data, conn) {
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return; }
    }

    if (data.type === "name_announcement") {
      if (activeConnections.has(conn.peer)) {
        activeConnections.get(conn.peer).name = data.name;
        updateDeviceRoster();
        appendSystemMessage(`${data.name} joined the room.`);
      }
    } else if (data.type === "chat") {
      appendChatMessage(data.sender, data.text, false);
    } else if (data.type === "file_meta") {
      receivingFiles.set(data.fileId, {
        meta: data,
        chunks: [],
        receivedChunks: 0,
      });
      progressWrapper.classList.remove("hidden");
      transferFileTitle.textContent = `Receiving: ${data.name}`;
    } else if (data.type === "file_chunk") {
      const record = receivingFiles.get(data.fileId);
      if (!record) return;

      record.chunks[data.index] = base64ToArrayBuffer(data.data);
      record.receivedChunks++;

      const percent = Math.min(100, Math.round((record.receivedChunks / record.meta.totalChunks) * 100));
      progressBar.style.width = `${percent}%`;
      transferFilePercent.textContent = `${percent}%`;
    } else if (data.type === "file_finish") {
      const record = receivingFiles.get(data.fileId);
      if (!record) return;

      progressWrapper.classList.add("hidden");
      progressBar.style.width = "0%";

      const blob = new Blob(record.chunks, { type: record.meta.mime });
      saveAndDisplayFile(blob, record.meta.name, record.meta.mime, data.sender);
      receivingFiles.delete(data.fileId);
    }
  }

  // Display Received File with In-Chat Media Preview
  function saveAndDisplayFile(blob, name, mime, sender) {
    const url = URL.createObjectURL(blob);

    // Auto-trigger browser download
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();

    // Render Preview in Chat
    const wrapper = document.createElement("div");
    wrapper.className = "chat-bubble peer";
    wrapper.innerHTML = `<div class="chat-author">${sender} (Shared File)</div><div>📄 <strong>${name}</strong> (${formatBytes(blob.size)})</div>`;

    if (mime.startsWith("image/")) {
      wrapper.innerHTML += `<div class="chat-media-preview"><img src="${url}" alt="${name}" /></div>`;
    } else if (mime.startsWith("video/")) {
      wrapper.innerHTML += `<div class="chat-media-preview"><video src="${url}" controls></video></div>`;
    } else if (mime.startsWith("audio/")) {
      wrapper.innerHTML += `<div class="chat-media-preview"><audio src="${url}" controls></audio></div>`;
    }

    wrapper.innerHTML += `<a href="${url}" download="${name}" style="color:#60a5fa; text-decoration: underline; font-size:0.75rem; display:inline-block; margin-top:4px;">Download again</a>`;
    chatMessages.appendChild(wrapper);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    log(`File "${name}" successfully received.`, "success");
  }

  // 6. Send Files in Base64 Chunks
  sendFilesBtn.addEventListener("click", async () => {
    if (!activeConnections.size) {
      showAlert("No connected devices to send files to.");
      return;
    }
    if (!selectedFiles.length) return;

    sendFilesBtn.disabled = true;
    progressWrapper.classList.remove("hidden");

    for (const file of selectedFiles) {
      const fileId = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      transferFileTitle.textContent = `Sending: ${file.name}`;

      // 1. Send Metadata
      broadcastData({
        type: "file_meta",
        fileId,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        totalChunks,
        sender: myName,
      });

      // 2. Read & Broadcast Chunks
      for (let i = 0; i < totalChunks; i++) {
        const slice = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();
        const base64Chunk = arrayBufferToBase64(buffer);

        broadcastData({
          type: "file_chunk",
          fileId,
          index: i,
          data: base64Chunk,
        });

        const percent = Math.min(100, Math.round(((i + 1) / totalChunks) * 100));
        progressBar.style.width = `${percent}%`;
        transferFilePercent.textContent = `${percent}%`;

        // Small pause to prevent buffer overflow
        await new Promise((r) => setTimeout(r, 6));
      }

      // 3. Send Complete Marker
      broadcastData({ type: "file_finish", fileId, sender: myName });

      // Append into own chat as sent
      appendFileSentNotification(file);
      log(`Sent: ${file.name}`, "success");
    }

    setTimeout(() => {
      progressWrapper.classList.add("hidden");
      progressBar.style.width = "0%";
      selectedFiles = [];
      selectedFilesList.innerHTML = "";
      sendFilesBtn.disabled = false;
    }, 800);
  });

  function broadcastData(payload) {
    const str = JSON.stringify(payload);
    activeConnections.forEach(({ conn }) => {
      if (conn.open) conn.send(str);
    });
  }

  function appendFileSentNotification(file) {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble mine";
    bubble.innerHTML = `<div class="chat-author">You</div><div>📤 Sent <strong>${file.name}</strong> (${formatBytes(file.size)})</div>`;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // 7. Drag & Drop Handlers
  ["dragenter", "dragover"].forEach((eName) => {
    dropZone.addEventListener(eName, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eName) => {
    dropZone.addEventListener(eName, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });

  dropZone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) handleFilesSelected(e.dataTransfer.files);
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) handleFilesSelected(e.target.files);
  });

  function handleFilesSelected(files) {
    selectedFiles = Array.from(files);
    selectedFilesList.innerHTML = "";

    selectedFiles.forEach((file) => {
      const el = document.createElement("div");
      el.className = "file-badge-item";
      el.innerHTML = `<span>📄 ${file.name}</span><span style="color:#64748b">${formatBytes(file.size)}</span>`;
      selectedFilesList.appendChild(el);
    });

    if (activeConnections.size > 0) {
      sendFilesBtn.disabled = false;
    } else {
      showAlert("Files staged. Once devices connect to this room, click 'Send'.", false);
    }
  }

  // 8. Live Chat
  function appendChatMessage(author, text, isMine) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${isMine ? "mine" : "peer"}`;
    bubble.innerHTML = `<div class="chat-author">${author}</div><div>${text}</div>`;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function appendSystemMessage(msg) {
    const div = document.createElement("div");
    div.className = "chat-system";
    div.textContent = msg;
    chatMessages.appendChild(div);
  }

  sendChatBtn.addEventListener("click", sendChat);
  chatText.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendChat();
  });

  function sendChat() {
    const text = chatText.value.trim();
    if (!text) return;

    appendChatMessage(myName, text, true);
    broadcastData({ type: "chat", sender: myName, text });
    chatText.value = "";
  }

  // 9. WebRTC Audio / Video Call
  startCallBtn.addEventListener("click", async () => {
    if (!activeConnections.size) {
      showAlert("Please wait for another device to enter the room before calling.");
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

      // Call first peer in room
      const remotePeerId = activeConnections.keys().next().value;
      currentCall = peer.call(remotePeerId, localStream);

      currentCall.on("stream", (remoteStream) => {
        remoteVideo.srcObject = remoteStream;
      });

      currentCall.on("close", cleanupCall);
      log(`Calling remote peer...`, "info");
    } catch (err) {
      showAlert(`Camera/Microphone access error: ${err.message}`);
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
        currentCall = call;

        call.on("stream", (remoteStream) => {
          remoteVideo.srcObject = remoteStream;
        });

        call.on("close", cleanupCall);
      })
      .catch((err) => showAlert(`Microphone/Camera permission error: ${err.message}`));
  }

  function cleanupCall() {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
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
    if (currentCall) currentCall.close();
    cleanupCall();
  });

  toggleMicBtn.addEventListener("click", () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      toggleMicBtn.textContent = audioTrack.enabled ? "🎤 Mute" : "🔇 Unmute";
    }
  });

  toggleCamBtn.addEventListener("click", () => {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      toggleCamBtn.textContent = videoTrack.enabled ? "📷 Video Off" : "📷 Video On";
    }
  });

  // 10. Recording Session Feature
  recordCallBtn.addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      // Stop recording
      mediaRecorder.stop();
      recordCallBtn.textContent = "⏺ Record Session";
      recordIndicator.classList.add("hidden");
      return;
    }

    try {
      let streamToRecord = localStream;
      if (!streamToRecord) {
        // Record screen / window if not in a call
        streamToRecord = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      }

      recordedChunks = [];
      mediaRecorder = new MediaRecorder(streamToRecord, { mimeType: "video/webm" });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const recordedBlob = new Blob(recordedChunks, { type: "video/webm" });
        const downloadUrl = URL.createObjectURL(recordedBlob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = `Dhurta-Session-${Date.now()}.webm`;
        a.click();
        log("Recording saved and downloaded.", "success");
      };

      mediaRecorder.start();
      recordCallBtn.textContent = "⏹ Stop Recording";
      recordIndicator.classList.remove("hidden");
      log("Recording started...", "info");
    } catch (err) {
      showAlert(`Could not start recorder: ${err.message}`);
    }
  });

  // 11. Multi-Window & Diagnostic Handlers
  openNewWindowBtn.addEventListener("click", () => {
    const url = shareLinkInput.value.startsWith("http") ? shareLinkInput.value : window.location.href;
    window.open(url, "_blank", "width=900,height=800");
  });

  copyLinkBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
      copyLinkBtn.textContent = "Copied!";
      setTimeout(() => (copyLinkBtn.textContent = "Copy"), 2000);
    });
  });

  joinRoomBtn.addEventListener("click", () => enterRoom(pinInput.value.trim()));

  randomRoomBtn.addEventListener("click", () => {
    const rand = Math.floor(1000 + Math.random() * 9000).toString();
    enterRoom(rand);
  });

  selfTestBtn.addEventListener("click", async () => {
    diagPanel.classList.remove("hidden");
    diagList.innerHTML = "<li>Running diagnostic check...</li>";

    const rtc = !!(window.RTCPeerConnection && window.MediaRecorder);
    diagList.innerHTML = `<li>WebRTC + MediaRecorder Support: ${rtc ? "✅ Supported" : "❌ Unsupported"}</li>`;

    try {
      const test = new Peer();
      test.on("open", (id) => {
        diagList.innerHTML += `<li>PeerJS Cloud Signaling: ✅ Operational (ID: ${id.slice(0, 6)}...)</li>`;
        test.destroy();
      });
      test.on("error", (err) => {
        diagList.innerHTML += `<li style="color:#ef4444">PeerJS Signaling Error: ${err.type}</li>`;
      });
    } catch (e) {
      diagList.innerHTML += `<li style="color:#ef4444">Test failed: ${e.message}</li>`;
    }
  });

  // URL Query PIN Auto-Init (?pin=XXXX)
  const urlParamPin = new URLSearchParams(window.location.search).get("pin");
  if (urlParamPin && /^\d{4}$/.test(urlParamPin)) {
    enterRoom(urlParamPin);
  } else {
    const initialPin = Math.floor(1000 + Math.random() * 9000).toString();
    enterRoom(initialPin);
  }
});