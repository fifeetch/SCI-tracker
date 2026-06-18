const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

const TYPE_LABELS = {
  message: "Nouveau message",
  reunion: "Rendez-vous SCI",
  decision: "Vote ou decision",
  document: "Document a traiter",
  alert: "Alerte SCI Family"
};

function preferenceKey(type){
  if(type === "vote") return "decision";
  if(type === "meeting") return "reunion";
  return TYPE_LABELS[type] ? type : "alert";
}

function isTokenEligible(tokenDoc, alert){
  const token = tokenDoc.token;
  if(!token || tokenDoc.enabled === false) return false;
  if(alert.createdBy && tokenDoc.uid && alert.createdBy === tokenDoc.uid) return false;

  const roles = Array.isArray(alert.targetRoles) ? alert.targetRoles : [];
  if(roles.length && !roles.includes(tokenDoc.role || "")) return false;

  const uids = Array.isArray(alert.targetUids) ? alert.targetUids : [];
  if(uids.length && !uids.includes(tokenDoc.uid || "")) return false;

  const prefs = tokenDoc.preferences || {};
  return prefs[preferenceKey(alert.type)] !== false;
}

function isMessageTokenEligible(tokenDoc, message){
  const token = tokenDoc.token;
  if(!token || tokenDoc.enabled === false) return false;
  if(message.authorUid && tokenDoc.uid && message.authorUid === tokenDoc.uid) return false;
  const prefs = tokenDoc.preferences || {};
  return prefs.message !== false;
}

async function sendWebPushToTokens({sciId, recipients, title, body, data, tag}){
  if(!recipients.length) return {successCount: 0, failureCount: 0, invalidTokens: []};
  const response = await admin.messaging().sendEachForMulticast({
    tokens: recipients.map((r) => r.token),
    notification: {title, body},
    data: {
      sciId,
      ...data
    },
    webpush: {
      fcmOptions: {
        link: "https://sci-family-ab82c.web.app/"
      },
      notification: {
        icon: "https://sci-family-ab82c.web.app/icons/icon.svg",
        badge: "https://sci-family-ab82c.web.app/icons/icon.svg",
        tag
      }
    }
  });

  const invalidTokens = [];
  response.responses.forEach((one, index) => {
    if(one.success) return;
    const code = one.error && one.error.code;
    logger.warn("Push notification failed", {code, sciId, tokenDocId: recipients[index].id});
    if(code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token"){
      invalidTokens.push(recipients[index].id);
    }
  });

  await Promise.all(invalidTokens.map((id) => admin.firestore()
    .collection("scis")
    .doc(sciId)
    .collection("pushTokens")
    .doc(id)
    .set({
      enabled: false,
      invalidatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, {merge: true})));

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    invalidTokens
  };
}

exports.notifyManagersOnAlert = onDocumentCreated(
  {
    document: "scis/{sciId}/alerts/{alertId}",
    region: "europe-west1"
  },
  async (event) => {
    const alert = event.data && event.data.data();
    const sciId = event.params.sciId;
    if(!alert || alert.pushSent === true) return;
    if(alert.type === "message") return;

    const title = alert.title || TYPE_LABELS[alert.type] || TYPE_LABELS.alert;
    const body = alert.text || "Nouvelle information disponible dans SCI Family.";
    const tokensSnap = await admin.firestore()
      .collection("scis")
      .doc(sciId)
      .collection("pushTokens")
      .where("enabled", "==", true)
      .get();

    const recipients = tokensSnap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .filter((tokenDoc) => isTokenEligible(tokenDoc, alert));

    if(!recipients.length){
      logger.info("No push recipient for alert", {sciId, alertId: event.params.alertId, type: alert.type});
      return;
    }

    const result = await sendWebPushToTokens({
      sciId,
      recipients,
      title,
      body,
      data: {
        alertId: event.params.alertId,
        type: String(alert.type || "alert"),
        url: "/"
      },
      tag: `${sciId}-${event.params.alertId}`
    });

    await event.data.ref.set({
      pushSent: true,
      pushSentAt: admin.firestore.FieldValue.serverTimestamp(),
      pushSuccessCount: result.successCount,
      pushFailureCount: result.failureCount
    }, {merge: true});
  }
);

exports.notifyOnMessageCreated = onDocumentCreated(
  {
    document: "scis/{sciId}/messages/{messageId}",
    region: "europe-west1"
  },
  async (event) => {
    const message = event.data && event.data.data();
    const sciId = event.params.sciId;
    if(!message || message.pushSent === true) return;

    const tokensSnap = await admin.firestore()
      .collection("scis")
      .doc(sciId)
      .collection("pushTokens")
      .where("enabled", "==", true)
      .get();

    const recipients = tokensSnap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .filter((tokenDoc) => isMessageTokenEligible(tokenDoc, message));

    if(!recipients.length){
      logger.info("No push recipient for message", {sciId, messageId: event.params.messageId});
      return;
    }

    const channel = message.channel || "general";
    const author = message.authorName || "Un membre";
    const text = String(message.message || "").slice(0, 160);
    const result = await sendWebPushToTokens({
      sciId,
      recipients,
      title: "Nouveau message SCI Family",
      body: `${author} - ${text}`,
      data: {
        messageId: event.params.messageId,
        type: "message",
        channel,
        url: "/"
      },
      tag: `${sciId}-message-${event.params.messageId}`
    });

    await event.data.ref.set({
      pushSent: true,
      pushSentAt: admin.firestore.FieldValue.serverTimestamp(),
      pushSuccessCount: result.successCount,
      pushFailureCount: result.failureCount
    }, {merge: true});
  }
);
