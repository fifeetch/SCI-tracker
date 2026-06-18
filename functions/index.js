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

exports.notifyManagersOnAlert = onDocumentCreated(
  {
    document: "scis/{sciId}/alerts/{alertId}",
    region: "europe-west1"
  },
  async (event) => {
    const alert = event.data && event.data.data();
    const sciId = event.params.sciId;
    if(!alert || alert.pushSent === true) return;

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

    const response = await admin.messaging().sendEachForMulticast({
      tokens: recipients.map((r) => r.token),
      notification: {title, body},
      data: {
        sciId,
        alertId: event.params.alertId,
        type: String(alert.type || "alert"),
        url: "/"
      },
      webpush: {
        fcmOptions: {
          link: "https://sci-family-ab82c.web.app/"
        },
        notification: {
          icon: "https://sci-family-ab82c.web.app/icons/icon.svg",
          badge: "https://sci-family-ab82c.web.app/icons/icon.svg",
          tag: `${sciId}-${event.params.alertId}`
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

    await event.data.ref.set({
      pushSent: true,
      pushSentAt: admin.firestore.FieldValue.serverTimestamp(),
      pushSuccessCount: response.successCount,
      pushFailureCount: response.failureCount
    }, {merge: true});
  }
);
