document.addEventListener("DOMContentLoaded", () => {
  // DOM Elements
  const myNameDisplay = document.getElementById("my-assigned-name");
  const pinInput = document.getElementById("pin-input");
  const joinPinBtn = document.getElementById("btn-join-pin");
  const randomPinBtn = document.getElementById("btn-random-pin");
  const shareLinkInput = document.getElementById("share-link");
  const copyLinkBtn = document.getElementById("btn-copy-link");
  const toggleQrBtn = document.getElementById("btn-toggle-qr");
  const qrDrawer = document.getElementById("qr-drawer");
  const closeQrBtn = document.getElementById("btn-close-qr");
  const qrRoomLabel = document.getElementById("qr-room-label");
  const connectionPill = document.getElementById("connection-pill");
  const openWindowBtn = document.getElementById("btn-open-window");
  const refreshRoomBtn = document.getElementById("btn-refresh-room");
  const deviceCountSpan = document.getElementById("device-count");
  const devicesRoster = document.getElementById("devices-roster");

  const alertBanner = document.getElementById("alert-banner");
  const alertText = document.getElementById("alert-text");
  const closeAlertBtn = document.getElementById("btn-close-alert");

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const stagedFilesDiv = document.getElementById("staged-files");
  const sendFilesBtn = document.getElementById("btn-send-files");

  const progressMonitor = document.getElementById("progress-monitor");
  const progressBarFill = document.getElementById("progress-bar-fill");
  const transferFilename = document.getElementById("transfer-filename");
  const transferPercent = document.getElementById("transfer-percent");
  const transferBytesInfo = document.getElementById("transfer-bytes-info");
  const transferEta = document.getElementById("transfer-eta");
  const speedMeter = document.getElementById("speed-meter");
  const channelBadge = document.getElementById("channel-type-badge");

  const chatStream = document.getElementById("chat-stream");
  const chatInput = document.getElementById("chat-input");
  const sendChatBtn = document.getElementById("btn-send-chat");

  const startCallBtn = document.getElementById("btn-start-call");
  const endCallBtn = document.getElementById("btn-end-call");
  const toggleMicBtn = document.getElementById("btn-toggle-mic");
  const toggleCamBtn = document.getElementById("btn-toggle-cam");
  const recordCallBtn = document.getElementById("btn-record-call");
  const videoGrid = document.getElementById("video-grid");
  const localVideo = document.getElementById("local-video");
  const remoteVideo = document.getElementById("remote-video");
  const recordBanner = document.getElementById("record-banner");

  // State
  const myDeviceId = "peer_" + Math.random().toString(36).substring(2, 9);
  let currentPin = null;
  let mqttClient = null;
  let currentTopic = null;

  // Roster & History
  let peers = new Map(); // peerId -> { name, lastSeen, pc, dc }
  let roomChatHistory = []; // { id, author, text, timestamp, fileMeta }
  let sharedFilesLocalMap = new Map(); // fileId -> File instance
  let stagedFiles = [];

  // WebRTC
  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ],
  };
  const CHUNK_SIZE = 64 * 1024; // 64 KB high-speed raw chunks
  const MAX_BUFFERED_THRESHOLD = 256 * 1024; // Flow-control backpressure limit

  let localStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];

  // Incoming heavy file reconstruction state
  let incomingHeavyFiles = new Map(); // fileId -> { meta, chunks, receivedBytes, startTime }

  // 1. Device Identity
  function getDeviceAlias() {
    let name = sessionStorage.getItem("dhurta_unified_name");
    if (!name) {
      const colors = ["Cyber", "Neon", "Cosmic", "Solar", "Emerald", "Ruby", "Shadow", "Amber"];
      const animals = ["Falcon", "Tiger", "Fox", "Wolf", "Hawk", "Eagle", "Cheetah", "Lynx"];
      name = `${colors[Math.floor(Math.random() * colors.length)]} ${animals[Math.floor(Math.random() * animals.length)]}`;
      sessionStorage.setItem("dhurta_unified_name", name);
    }
    return name;
  }
  const myName = getDeviceAlias();
  myNameDisplay.textContent = myName;

  function showAlert(msg, isError = false) {
    alertText.textContent = msg;
    alertBanner.className = isError ? "alert-banner error" : "alert-banner";
    alertBanner.classList.remove("hidden");
  }
  closeAlertBtn.addEventListener("click", () => alertBanner.classList.add("hidden"));

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  // 2. Client-Side QR Generator
  function renderQR(url) {
    const qrContainer = document.getElementById("qrcode");
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, {
      text: url,
      width: 180,
      height: 180,
      colorDark: "#080b11",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  // 3. Room Management & Signaling Mesh
  function enterRoom(pin) {
    if (!/^\d{4}$/.test(pin)) {
      showAlert("Please enter a valid 4-digit room code (e.g. 4829).", true);
      return;
    }

    currentPin = pin;
    pinInput.value = pin;
    qrRoomLabel.textContent = `#${pin}`;

    const fullUrl = `${window.location.origin}${window.location.pathname}?pin=${pin}`;
    shareLinkInput.value = fullUrl;
    renderQR(fullUrl);

    // Close any previous connections cleanly
    teardownWebRTC();

    currentTopic = `dhurta_unity_v6/room_${pin}`;
    connectionPill.textContent = `Connecting to #${pin}...`;
    connectionPill.className = "status-pill online";

    if (mqttClient) {
      mqttClient.end(true);
    }

    // Connect to reliable WSS signaling bus
    mqttClient = mqtt.connect("wss://broker.emqx.io:8084/mqtt", {
      clientId: `dhurta_${myDeviceId}`,
      clean: true,
      connectTimeout: 7000,
      reconnectPeriod: 2000,
    });

    mqttClient.on("connect", () => {
      connectionPill.textContent = `Room ${pin} (Ready)`;
      connectionPill.className = "status-pill online";

      mqttClient.subscribe(currentTopic, { qos: 0 }, (err) => {
        if (!err) {
          // Announce presence and request historical data from existing members
          broadcastSignal({ type: "presence_announce", wantsHistory: true });
        }
      });
    });

    mqttClient.on("message", (t, msgBuf) => {
      try {
        const data = JSON.parse(msgBuf.toString());
        if (data.senderId === myDeviceId) return; // ignore self
        handleSignalMessage(data);
      } catch (err) {
        console.error("Signal parsing error:", err);
      }
    });

    mqttClient.on("error", (e) => {
      showAlert(`Signaling event: ${e.message}`, true);
    });

    mqttClient.on("close", () => {
      connectionPill.textContent = "Reconnecting...";
      connectionPill.className = "status-pill offline";
    });
  }

  function broadcastSignal(payload) {
    if (!mqttClient || !mqttClient.connected || !currentTopic) return;
    payload.senderId = myDeviceId;
    payload.senderName = myName;
    mqttClient.publish(currentTopic, JSON.stringify(payload));
  }

  function sendDirectSignal(targetId, payload) {
    payload.targetId = targetId;
    broadcastSignal(payload);
  }

  // 4. Presence, Roster & History Catch-up Engine
  function handleSignalMessage(data) {
    if (data.targetId && data.targetId !== myDeviceId) return; // targeted for another peer

    // Track peer in roster
    const isNew = !peers.has(data.senderId);
    let peerObj = peers.get(data.senderId) || { name: data.senderName, lastSeen: Date.now() };
    peerObj.lastSeen = Date.now();
    peerObj.name = data.senderName;
    peers.set(data.senderId, peerObj);

    if (isNew) {
      updateRoster();
      showAlert(`${data.senderName} joined room #${currentPin}!`, false);
      // Coordinate direct WebRTC DataChannel connection
      initiateWebRTCConnection(data.senderId, true);
    }

    // Historical Sync for New Members
    if (data.type === "presence_announce") {
      // If we have history and the newcomer needs it, transmit it
      if (roomChatHistory.length > 0 && data.wantsHistory) {
        sendDirectSignal(data.senderId, {
          type: "history_sync_packet",
          history: roomChatHistory,
        });
      }
    } else if (data.type === "history_sync_packet") {
      integrateHistoricalData(data.history);
    } else if (data.type === "chat_message") {
      appendChatMessage(data.senderName, data.text, false, data.fileMeta, data.id);
    } else if (data.type === "file_request_download") {
      // A new peer wants a file shared earlier
      handleRemoteFileRequest(data.fileId, data.senderId);
    } else if (data.type === "rtc_offer") {
      handleRtcOffer(data.senderId, data.offer);
    } else if (data.type === "rtc_answer") {
      handleRtcAnswer(data.senderId, data.answer);
    } else if (data.type === "rtc_ice") {
      handleRtcIce(data.senderId, data.candidate);
    } else if (data.type === "room_refresh_request") {
      renegotiatePeer(data.senderId);
    }
  }

  function integrateHistoricalData(incomingHistory) {
    incomingHistory.forEach((item) => {
      // Avoid duplicates
      if (!roomChatHistory.some((h) => h.id === item.id)) {
        appendChatMessage(item.author, item.text, item.author === myName, item.fileMeta, item.id);
      }
    });
  }

  // Heartbeat interval: keep roster clean
  setInterval(() => {
    if (mqttClient && mqttClient.connected) {
      broadcastSignal({ type: "heartbeat_ping" });

      const now = Date.now();
      let changed = false;
      peers.forEach((val, pId) => {
        if (now - val.lastSeen > 8000) {
          if (val.pc) val.pc.close();
          peers.delete(pId);
          changed = true;
        }
      });
      if (changed) updateRoster();
    }
  }, 2500);

  function updateRoster() {
    devicesRoster.innerHTML = "";
    const total = peers.size + 1;
    deviceCountSpan.textContent = total;

    // Self
    const selfEl = document.createElement("div");
    selfEl.className = "device-entry self";
    selfEl.innerHTML = `<span><strong>${myName}</strong> (You)</span><span class="status">Host/Self</span>`;
    devicesRoster.appendChild(selfEl);

    // Peers
    peers.forEach((p) => {
      const el = document.createElement("div");
      el.className = "device-entry";
      const hasDC = p.dc && p.dc.readyState === "open";
      el.innerHTML = `<span>${p.name}</span><span class="status" style="color:${hasDC ? "#10b981" : "#f59e0b"}">${hasDC ? "P2P Turbo" : "Signaled"}</span>`;
      devicesRoster.appendChild(el);
    });

    if (peers.size > 0) {
      connectionPill.textContent = `Connected (${total} Devices)`;
      connectionPill.className = "status-pill connected";
    } else {
      connectionPill.textContent = `Room ${currentPin} (Waiting for Peer)`;
      connectionPill.className = "status-pill online";
    }
  }

  // 5. Heavy-Duty WebRTC DataChannel Engine (Direct P2P, Zero-Limit)
  function teardownWebRTC() {
    peers.forEach((p) => {
      if (p.dc) p.dc.close();
      if (p.pc) p.pc.close();
    });
    peers.clear();
    updateRoster();
  }

  async function initiateWebRTCConnection(peerId, isInitiator) {
    const peerData = peers.get(peerId);
    if (!peerData) return;

    const pc = new RTCPeerConnection(rtcConfig);
    peerData.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendDirectSignal(peerId, { type: "rtc_ice", candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
      videoGrid.classList.remove("hidden");
    };

    if (isInitiator) {
      // Create high-throughput binary DataChannel
      const dc = pc.createDataChannel("dhurtaHeavyP2P", { ordered: true });
      setupDataChannel(peerId, dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendDirectSignal(peerId, { type: "rtc_offer", offer });
    } else {
      pc.ondatachannel = (e) => {
        setupDataChannel(peerId, e.channel);
      };
    }
  }

  async function handleRtcOffer(senderId, offer) {
    let peerData = peers.get(senderId);
    if (!peerData) return;

    const pc = new RTCPeerConnection(rtcConfig);
    peerData.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendDirectSignal(senderId, { type: "rtc_ice", candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
      videoGrid.classList.remove("hidden");
    };

    pc.ondatachannel = (e) => {
      setupDataChannel(senderId, e.channel);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendDirectSignal(senderId, { type: "rtc_answer", answer });
  }

  async function handleRtcAnswer(senderId, answer) {
    const peerData = peers.get(senderId);
    if (peerData && peerData.pc) {
      await peerData.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  async function handleRtcIce(senderId, candidate) {
    const peerData = peers.get(senderId);
    if (peerData && peerData.pc) {
      try {
        await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error("ICE error:", e);
      }
    }
  }

  function setupDataChannel(peerId, dc) {
    dc.binaryType = "arraybuffer";
    const p = peers.get(peerId);
    if (p) p.dc = dc;

    dc.onopen = () => {
      channelBadge.textContent = "🚀 Direct WebRTC Active";
      channelBadge.className = "stat-badge p2p";
      updateRoster();
    };

    dc.onclose = () => {
      updateRoster();
    };

    dc.onmessage = (event) => {
      handleIncomingDataPacket(event.data, peerId);
    };
  }

  // 6. Streaming Heavy Binary Chunks without Freezing
  async function waitForBufferDrain(dc) {
    if (dc.bufferedAmount > MAX_BUFFERED_THRESHOLD) {
      await new Promise((resolve) => {
        const handler = () => {
          dc.removeEventListener("bufferedamountlow", handler);
          resolve();
        };
        dc.bufferedAmountLowThreshold = 64 * 1024;
        dc.addEventListener("bufferedamountlow", handler);
        // Safety timeout
        setTimeout(resolve, 35);
      });
    }
  }

  async function streamFileToDataChannel(file, dc, fileId) {
    const total = file.size;
    let offset = 0;
    const startTime = Date.now();

    // 1. Transmit JSON Header with metadata
    dc.send(
      JSON.stringify({
        type: "heavy_header",
        fileId,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
      })
    );

    // 2. Stream raw binary slices (Memory Efficient: Slice on demand)
    while (offset < total) {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();

      await waitForBufferDrain(dc);
      dc.send(buffer);

      offset += buffer.byteLength;

      // Update UI
      const pct = Math.min(100, Math.round((offset / total) * 100));
      progressBarFill.style.width = `${pct}%`;
      transferPercent.textContent = `${pct}%`;
      transferBytesInfo.textContent = `${formatBytes(offset)} / ${formatBytes(total)}`;

      // Calculate Speed & ETA
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0.3) {
        const bytesPerSec = offset / elapsed;
        speedMeter.textContent = `${formatBytes(bytesPerSec)}/s`;
        const remainingBytes = total - offset;
        const secondsRemaining = Math.ceil(remainingBytes / bytesPerSec);
        transferEta.textContent = `${secondsRemaining}s remaining`;
      }
    }

    // 3. Transmit Completion Marker
    dc.send(JSON.stringify({ type: "heavy_eof", fileId }));
  }

  // Incoming binary assembly
  function handleIncomingDataPacket(data, peerId) {
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "heavy_header") {
          incomingHeavyFiles.set(msg.fileId, {
            meta: msg,
            chunks: [],
            receivedBytes: 0,
            startTime: Date.now(),
          });
          progressMonitor.classList.remove("hidden");
          transferFilename.textContent = `Downloading: ${msg.name}`;
        } else if (msg.type === "heavy_eof") {
          const rec = incomingHeavyFiles.get(msg.fileId);
          if (!rec) return;

          progressMonitor.classList.add("hidden");
          progressBarFill.style.width = "0%";
          speedMeter.textContent = "0 MB/s";

          // Assemble complete Blob and auto-download
          const blob = new Blob(rec.chunks, { type: rec.meta.mime });
          finalizeDownloadedFile(blob, rec.meta.name, rec.meta.mime, msg.fileId);
          incomingHeavyFiles.delete(msg.fileId);
        }
      } catch (err) {
        console.error("Packet parse error:", err);
      }
    } else {
      // Raw Binary ArrayBuffer Chunk
      // Associate with the currently open file
      const activeEntry = [...incomingHeavyFiles.values()][0];
      if (activeEntry) {
        activeEntry.chunks.push(data);
        activeEntry.receivedBytes += data.byteLength;

        const total = activeEntry.meta.size;
        const pct = Math.min(100, Math.round((activeEntry.receivedBytes / total) * 100));
        progressBarFill.style.width = `${pct}%`;
        transferPercent.textContent = `${pct}%`;
        transferBytesInfo.textContent = `${formatBytes(activeEntry.receivedBytes)} / ${formatBytes(total)}`;

        const elapsed = (Date.now() - activeEntry.startTime) / 1000;
        if (elapsed > 0.3) {
          const speed = activeEntry.receivedBytes / elapsed;
          speedMeter.textContent = `${formatBytes(speed)}/s`;
          const remainingBytes = total - activeEntry.receivedBytes;
          const eta = Math.ceil(remainingBytes / speed);
          transferEta.textContent = `${eta}s remaining`;
        }
      }
    }
  }

  function finalizeDownloadedFile(blob, name, mime, fileId) {
    const url = URL.createObjectURL(blob);

    // Auto-trigger browser download
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();

    // Render Preview Card in Chat
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble peer";
    bubble.innerHTML = `
      <div class="chat-author">Shared File Received</div>
      <div class="chat-file-card">
        <div class="chat-file-meta">
          <strong>${name}</strong>
          <span style="font-size:0.72rem; color:#94a3b8;">${formatBytes(blob.size)}</span>
        </div>
        <a href="${url}" download="${name}" class="btn primary sm">Save Again</a>
      </div>
    `;

    if (mime.startsWith("image/")) {
      bubble.innerHTML += `<div class="chat-media-preview"><img src="${url}" alt="${name}" /></div>`;
    } else if (mime.startsWith("video/")) {
      bubble.innerHTML += `<div class="chat-media-preview"><video src="${url}" controls></video></div>`;
    } else if (mime.startsWith("audio/")) {
      bubble.innerHTML += `<div class="chat-media-preview"><audio src="${url}" controls></audio></div>`;
    }

    chatStream.appendChild(bubble);
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  // 7. Sending Files
  sendFilesBtn.addEventListener("click", async () => {
    if (!stagedFiles.length) {
      showAlert("Please drag and drop or select files first.", true);
      return;
    }

    sendFilesBtn.disabled = true;
    progressMonitor.classList.remove("hidden");

    for (const file of stagedFiles) {
      const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sharedFilesLocalMap.set(fileId, file);

      transferFilename.textContent = `Streaming: ${file.name}`;

      const meta = { fileId, name: file.name, size: file.size, mime: file.type || "application/octet-stream" };

      // Announce file to room chat history
      appendChatMessage(myName, `Shared file: ${file.name}`, true, meta, fileId);
      broadcastSignal({
        type: "chat_message",
        text: `Shared file: ${file.name}`,
        fileMeta: meta,
        id: fileId,
      });

      // Stream to every connected peer via their direct DataChannel
      for (const [pId, p] of peers.entries()) {
        if (p.dc && p.dc.readyState === "open") {
          await streamFileToDataChannel(file, p.dc, fileId);
        }
      }
    }

    setTimeout(() => {
      progressMonitor.classList.add("hidden");
      progressBarFill.style.width = "0%";
      speedMeter.textContent = "0 MB/s";
      stagedFiles = [];
      stagedFilesDiv.innerHTML = "";
      sendFilesBtn.disabled = false;
      showAlert("Heavy file transfer completed!", false);
    }, 500);
  });

  // Handle requests for previous files from newcomers
  async function handleRemoteFileRequest(fileId, requesterId) {
    const file = sharedFilesLocalMap.get(fileId);
    const peerData = peers.get(requesterId);
    if (file && peerData && peerData.dc && peerData.dc.readyState === "open") {
      showAlert(`Transmitting cached file ${file.name} to newcomer...`, false);
      progressMonitor.classList.remove("hidden");
      transferFilename.textContent = `Re-syncing: ${file.name}`;
      await streamFileToDataChannel(file, peerData.dc, fileId);
      progressMonitor.classList.add("hidden");
    }
  }

  // 8. Drag and Drop Staging
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
    if (e.dataTransfer.files.length) stageFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) stageFiles(e.target.files);
  });

  function stageFiles(files) {
    stagedFiles = Array.from(files);
    stagedFilesDiv.innerHTML = "";

    stagedFiles.forEach((f) => {
      const row = document.createElement("div");
      row.className = "staged-row";
      row.innerHTML = `<span>📄 <strong>${f.name}</strong></span><span style="color:#94a3b8;">${formatBytes(f.size)}</span>`;
      stagedFilesDiv.appendChild(row);
    });

    showAlert(`${stagedFiles.length} file(s) staged. Click 'Send Staged Files' to transfer at full speed!`, false);
  }

  // 9. Real-Time Chat & History Persistence
  function appendChatMessage(author, text, isMine, fileMeta = null, id = null) {
    const msgId = id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    roomChatHistory.push({ id: msgId, author, text, timestamp: Date.now(), fileMeta });

    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${isMine ? "mine" : "peer"}`;
    bubble.innerHTML = `<div class="chat-author">${author}</div><div>${text}</div>`;

    if (fileMeta) {
      bubble.innerHTML += `
        <div class="chat-file-card">
          <div class="chat-file-meta">
            <strong>${fileMeta.name}</strong>
            <span style="font-size:0.72rem; color:#94a3b8;">${formatBytes(fileMeta.size)}</span>
          </div>
          <button class="btn primary sm" onclick="window.requestFileDownload('${fileMeta.fileId}')">Download</button>
        </div>
      `;
    }

    chatStream.appendChild(bubble);
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  window.requestFileDownload = (fileId) => {
    broadcastSignal({ type: "file_request_download", fileId });
    showAlert("Requested file stream from room host...", false);
  };

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    appendChatMessage(myName, text, true, null, id);
    broadcastSignal({ type: "chat_message", text, id });
    chatInput.value = "";
  }

  sendChatBtn.addEventListener("click", sendChatMessage);
  chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });

  // 10. Room Re-sync Without Exiting
  refreshRoomBtn.addEventListener("click", () => {
    refreshRoomBtn.classList.add("spinning");
    showAlert("Refreshing room connections...", false);

    // Send re-sync pulse to all peers
    broadcastSignal({ type: "room_refresh_request" });

    // Re-negotiate WebRTC with each peer
    peers.forEach((p, pId) => {
      renegotiatePeer(pId);
    });

    setTimeout(() => {
      refreshRoomBtn.classList.remove("spinning");
      showAlert(`Room #${currentPin} successfully re-synchronized!`, false);
    }, 600);
  });

  function renegotiatePeer(peerId) {
    const p = peers.get(peerId);
    if (p && p.pc) {
      p.pc.close();
    }
    initiateWebRTCConnection(peerId, true);
  }

  // 11. Audio / Video Call & Session Recording
  startCallBtn.addEventListener("click", async () => {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      videoGrid.classList.remove("hidden");

      startCallBtn.classList.add("hidden");
      endCallBtn.classList.remove("hidden");
      toggleMicBtn.classList.remove("hidden");
      toggleCamBtn.classList.remove("hidden");

      // Attach tracks to all connected WebRTC peer connections
      peers.forEach((p) => {
        if (p.pc) {
          localStream.getTracks().forEach((track) => p.pc.addTrack(track, localStream));
          renegotiatePeer(p.peerId);
        }
      });
    } catch (e) {
      showAlert(`Camera/Microphone error: ${e.message}`, true);
    }
  });

  endCallBtn.addEventListener("click", () => {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    videoGrid.classList.add("hidden");

    startCallBtn.classList.remove("hidden");
    endCallBtn.classList.add("hidden");
    toggleMicBtn.classList.add("hidden");
    toggleCamBtn.classList.add("hidden");
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
      toggleCamBtn.textContent = track.enabled ? "📷 Cam Off" : "📷 Cam On";
    }
  });

  recordCallBtn.addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      recordCallBtn.textContent = "⏺ Record";
      recordBanner.classList.add("hidden");
      return;
    }

    try {
      let streamToRecord = localStream;
      if (!streamToRecord) {
        streamToRecord = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      }

      recordedChunks = [];
      mediaRecorder = new MediaRecorder(streamToRecord, { mimeType: "video/webm" });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Dhurta-Record-${Date.now()}.webm`;
        a.click();
        showAlert("Session recording downloaded!", false);
      };

      mediaRecorder.start();
      recordCallBtn.textContent = "⏹ Stop Recording";
      recordBanner.classList.remove("hidden");
    } catch (err) {
      showAlert(`Record failed: ${err.message}`, true);
    }
  });

  // 12. Controls & Initial Bootstrap
  joinPinBtn.addEventListener("click", () => enterRoom(pinInput.value.trim()));
  randomPinBtn.addEventListener("click", () => {
    const r = Math.floor(1000 + Math.random() * 9000).toString();
    enterRoom(r);
  });

  openWindowBtn.addEventListener("click", () => {
    const url = shareLinkInput.value.startsWith("http") ? shareLinkInput.value : window.location.href;
    window.open(url, "_blank", "width=960,height=840");
  });

  copyLinkBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
      copyLinkBtn.textContent = "Copied!";
      setTimeout(() => (copyLinkBtn.textContent = "Copy"), 2000);
    });
  });

  toggleQrBtn.addEventListener("click", () => qrDrawer.classList.remove("hidden"));
  closeQrBtn.addEventListener("click", () => qrDrawer.classList.add("hidden"));

  // Initial Load from URL query (?pin=XXXX)
  const queryPin = new URLSearchParams(window.location.search).get("pin");
  if (queryPin && /^\d{4}$/.test(queryPin)) {
    enterRoom(queryPin);
  } else {
    const defaultPin = Math.floor(1000 + Math.random() * 9000).toString();
    enterRoom(defaultPin);
  }
});