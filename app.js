/* Inline script 1 */
// ══ FIREBASE INIT ══
const fbApp = firebase.initializeApp({
  apiKey:            "AIzaSyCssgfhnAkaaP4TQxTyi5amY_C_ztrJeds",
  authDomain:        "sci-family-ab82c.firebaseapp.com",
  projectId:         "sci-family-ab82c",
  storageBucket:     "sci-family-ab82c.firebasestorage.app",
  messagingSenderId: "339961639799",
  appId:             "1:339961639799:web:0ca110231758437021a772"
});
const auth = firebase.auth();
const db   = firebase.firestore();
// ── FIX V1.0.5 : désactiver le cache persistant Firestore ──
// Le cache IndexedDB local causait des données corrompues entre utilisateurs :
// chaque user voyait son propre cache au lieu des vraies données serveur.
// V1.0.7 : aucun cache persistant Firestore. On force les lectures serveur au démarrage.
db.enableNetwork().catch(()=>{}); // forcer connexion réseau
const storage = firebase.storage();


// V1.0.7 : reset local agressif si URL ?resetLocal=1
async function emergencyLocalReset(){
  try{ stopAll?.(); }catch(e){}
  try{ await auth.signOut(); }catch(e){}
  try{
    localStorage.clear();
    sessionStorage.clear();
  }catch(e){}
  try{
    if(window.caches){
      const keys = await caches.keys();
      await Promise.all(keys.map(k=>caches.delete(k)));
    }
  }catch(e){}
  try{
    if(navigator.serviceWorker){
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r=>r.unregister()));
    }
  }catch(e){}
  try{
    if(indexedDB && indexedDB.databases){
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.filter(d=>/firestore|firebase|sci/i.test(d.name||'')).map(d=>new Promise(resolve=>{
        const req=indexedDB.deleteDatabase(d.name); req.onsuccess=req.onerror=req.onblocked=()=>resolve();
      })));
    }
  }catch(e){}
  location.href = location.origin + location.pathname + '?v=108-clean';
}
if(new URLSearchParams(location.search).get('resetLocal')==='1') emergencyLocalReset();
window.emergencyLocalReset = emergencyLocalReset;


// V1.0.8 : multi-SCI propre, avec fallback stable sur scis/default.
let SCI_ID  = 'default';
// V1.1.2 : on ne décide plus la SCI active depuis le localStorage.
// La vraie source est Firestore users/{uid}.activeSci, chargée dans loadUserRole().
const CACHE   = {biens:[],locataires:[],associes:[],ops:[],budgets:[],docs:[],echs:[],messages:[],decisions:[],pvs:[],pouvoirs:[],baux:[],activity:[],alerts:[],settings:[]};
const APP_STATE = { role:'associe', profile:null, scis:[], currentSCI:null };
const _unsubs = [];
function isGerant(){ return APP_STATE.role === 'gerant'; }
function canWrite(){ return isGerant(); }
function denyWrite(){ window.SCIapp?.toast?.('Accès lecture seule : seul un gérant peut modifier.'); }
window.canWrite = canWrite;

function isGFAContext(){ return SCI_ID === 'gfa_familial'; }
function activeDocId(){ return SCI_ID; }
function activeCollectionName(c){ return c; }
function colRef(c)    { return db.collection('scis').doc(activeDocId()).collection(activeCollectionName(c)); }
function entityName(){ return APP_STATE.currentSCI?.nom || (isGFAContext() ? 'GFA familial' : SCI_ID || 'SCI'); }
function entityType(){ return isGFAContext() ? 'GFA' : 'SCI'; }
function applyEntityUI(){
  const key = SCI_ID === 'default' ? 'default' : (SCI_ID === 'sci_catherine' ? 'sci_catherine' : (isGFAContext() ? 'gfa_familial' : 'other'));
  document.body.setAttribute('data-entity', key);
  const name = entityName();
  const logo = document.querySelector('.logo-icon');
  if(logo) logo.textContent = 'SF';
  const title = document.getElementById('active-structure-title') || document.querySelector('.logo h1');
  if(title) title.textContent = name;
  const sub = document.getElementById('active-structure-subtitle') || document.querySelector('.logo span');
  if(sub) sub.textContent = isGFAContext() ? 'Gestion foncière' : 'Gestion immobilière';
  applyGfaNavigation();
}

function applyGfaNavigation(){
  const gfa = isGFAContext();
  const biensBtn = document.querySelector('header nav button[data-page="biens"]');
  if(biensBtn) biensBtn.textContent = gfa ? 'Parcelles' : 'Biens';
  const comptaBtn = document.querySelector('header nav button[data-page="compta"]');
  if(comptaBtn) comptaBtn.textContent = gfa ? 'Compta GFA' : 'Comptabilité';
  const docsBtn = document.querySelector('header nav button[data-page="documents"]');
  if(docsBtn) docsBtn.textContent = gfa ? 'Docs GFA' : 'Documents';
  const bottomBiens = document.querySelector('#mn-biens');
  if(bottomBiens) bottomBiens.innerHTML = gfa ? '<span class="mico">🌾</span>Parcelles' : '<span class="mico">🏢</span>Biens immo';
}

async function dbSet(col, obj){
  if(!canWrite()){ denyWrite(); throw new Error('Accès lecture seule'); }
  if(!obj.id) obj.id = Date.now();
  const enriched = {
    ...obj,
    _sciId: SCI_ID,
    _updatedBy: auth.currentUser?.uid || '',
    _updatedByEmail: auth.currentUser?.email || '',
    _updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  await colRef(col).doc(String(enriched.id)).set(enriched);
  return enriched;
}
async function dbDel(col, id){
  if(!canWrite()){ denyWrite(); throw new Error('Accès lecture seule'); }
  await colRef(col).doc(String(id)).delete();
}
function dbListen(col, cb){
  const u = colRef(col).onSnapshot(
    { includeMetadataChanges: false },
    snap=>{
      // FIX V1.0.5 : ignorer les snapshots venant du cache local
      if(snap.metadata.fromCache) return;
      CACHE[col] = snap.docs.map(d=>{ const data=d.data()||{}; return data.id==null ? {...data,id:d.id} : data; });
      cb();
    },
    err=>{
      console.error('Erreur Firestore sur', col, err);
      window.SCIapp?.toast('Erreur Firestore : ' + err.message);
    }
  );
  _unsubs.push(u);
}
function stopAll(){ _unsubs.forEach(u=>u()); _unsubs.length=0; }

async function seedIfEmpty(){
  // V0.08 : base volontairement vide.
  // Les anciennes données d’exemple ne sont plus recréées automatiquement.
  return;
}

async function deleteCollectionDocs(col){
  if(!canWrite()){ denyWrite(); throw new Error('Accès lecture seule'); }
  const snap = await colRef(col).get();
  const batch = db.batch();
  snap.docs.forEach(doc => batch.delete(doc.ref));
  if(!snap.empty) await batch.commit();
  CACHE[col] = [];
}

window.resetSCIData = async function(){
  if(!canWrite()){ denyWrite(); return; }
  const ok = confirm('Vider toutes les données de la structure active ? Biens, locataires, associés, opérations, documents, échéances, messages et décisions seront supprimés. Cette action est définitive.');
  if(!ok) return;
  try{
    await Promise.all(['biens','locataires','associes','ops','budgets','docs','echs','messages','decisions','pvs','pouvoirs','baux','activity','alerts','settings'].map(deleteCollectionDocs));
    window.SCIapp?.toast('Structure vidée ✓');
    window.SCIapp?.onData?.('reset');
  }catch(err){
    console.error('Erreur reset SCI', err);
    window.SCIapp?.toast('Erreur suppression : ' + err.message);
  }
};

async function startListeners(){
  // V1.1.0 : écoute les collections de la structure active.
  // Pour le GFA, les données sont isolées sous scis/gfa_familial, comme une structure indépendante.
  if(!SCI_ID) SCI_ID = 'default';
  try{ await firebase.auth().currentUser?.getIdToken(true); }catch(e){ console.warn('[SCI] token refresh', e); }

  const ACTIVE_SCI = SCI_ID;
  const COLS = ['biens','locataires','associes','ops','budgets','docs','echs','messages','pvs','pouvoirs','baux','activity','alerts','settings'];

  async function loadColFromServer(col){
    const snap = colRef(col).get ? await colRef(col).get({source:'server'}) : null;
    CACHE[col] = snap.docs.map(d=>{ const data=d.data()||{}; return data.id==null ? {...data,id:d.id} : data; });
  }

  for(const col of COLS){
    try{ await loadColFromServer(col); }
    catch(e){ console.error('[SCI V1.1.0] Lecture serveur échouée sur '+activeDocId()+'/'+activeCollectionName(col), e); }
  }

  try{
    const decSnap = await colRef('decisions').get({source:'server'});
    CACHE.decisions = await Promise.all(decSnap.docs.map(async doc=>{
      const data = doc.data() || {};
      try{
        const vs = await doc.ref.collection('votes').get({source:'server'});
        data.votes = vs.docs.map(v=>v.data());
      }catch(e){ data.votes = []; }
      return data.id==null ? {...data,id:doc.id} : data;
    }));
  }catch(e){ console.error('[SCI V1.1.0] Lecture serveur décisions échouée', e); }

  window.SCIapp?.onData('server-load');

  COLS.forEach(col=>{
    const u = colRef(col).onSnapshot(snap=>{
      if(ACTIVE_SCI !== SCI_ID) return;
      CACHE[col] = snap.docs.map(d=>{ const data=d.data()||{}; return data.id==null ? {...data,id:d.id} : data; });
      window.SCIapp?.onData(col);
    }, err=>{
      console.error('[SCI V1.1.0] Listener échoué sur '+activeDocId()+'/'+activeCollectionName(col), err);
      window.SCIapp?.toast?.('Erreur Firestore '+col+' : '+err.message);
    });
    _unsubs.push(u);
  });

  const ud = colRef('decisions').onSnapshot(async snap=>{
    if(ACTIVE_SCI !== SCI_ID) return;
    const rows = await Promise.all(snap.docs.map(async doc=>{
      const data = doc.data() || {};
      try{
        const vs = await doc.ref.collection('votes').get({source:'server'});
        data.votes = vs.docs.map(v=>v.data());
      }catch(e){ data.votes = []; }
      return data.id==null ? {...data,id:doc.id} : data;
    }));
    CACHE.decisions = rows;
    window.SCIapp?.onData('decisions');
  }, err=>{
    console.error('[SCI V1.1.0] Listener décisions échoué', err);
    window.SCIapp?.toast?.('Erreur décisions : '+err.message);
  });
  _unsubs.push(ud);
}

function showAuthError(msg){
  const el = document.getElementById('auth-error');
  if(el){
    el.textContent = msg;
    el.style.display = 'block';
    el.style.background = 'rgba(224,90,75,.12)';
    el.style.borderColor = 'var(--red)';
    el.style.color = 'var(--red)';
  }
  console.warn('[AUTH]', msg);
}
function clearAuthError(){
  const el = document.getElementById('auth-error');
  if(el){
    el.textContent = '';
    el.style.display = 'none';
  }
}
function showAuthInfo(msg){
  const el = document.getElementById('auth-error');
  if(el){
    el.textContent = msg;
    el.style.display = 'block';
    el.style.background = 'rgba(76,175,130,.12)';
    el.style.borderColor = 'var(--green)';
    el.style.color = 'var(--green)';
  }
}
function setAuthLoading(isLoading, label){
  const login = document.getElementById('btn-login');
  const register = document.getElementById('btn-register');
  const reset = document.getElementById('btn-reset-password');
  [login, register, reset].forEach(btn=>{
    if(!btn) return;
    btn.disabled = !!isLoading;
    btn.style.opacity = isLoading ? '.65' : '1';
    btn.style.cursor = isLoading ? 'wait' : 'pointer';
  });
  if(label && register) register.textContent = label;
  if(label && reset) reset.textContent = label;
  if(!isLoading && register) register.textContent = 'Créer un compte';
  if(!isLoading && login) login.textContent = 'Se connecter';
  if(!isLoading && reset) reset.textContent = 'Mot de passe oublié ?';
}
function getAuthInputs(){
  const emailEl = document.getElementById('auth-email');
  const passEl  = document.getElementById('auth-pass');
  const email = (emailEl?.value || '').trim();
  const pass  = passEl?.value || '';
  return { email, pass, emailEl, passEl };
}
function validateAuthInputs(mode){
  const { email, pass, emailEl, passEl } = getAuthInputs();
  if(!email){
    showAuthError('Saisis ton email dans le champ EMAIL. Le texte gris est seulement un exemple.');
    emailEl?.focus();
    return null;
  }
  if(!pass){
    showAuthError('Saisis ton mot de passe.');
    passEl?.focus();
    return null;
  }
  if(!email.includes('@')){
    showAuthError('Email invalide : il manque probablement le @.');
    emailEl?.focus();
    return null;
  }
  if(mode === 'register' && pass.length < 6){
    showAuthError('Mot de passe : 6 caractères minimum.');
    passEl?.focus();
    return null;
  }
  clearAuthError();
  return { email, pass };
}
function validateResetEmail(){
  const { email, emailEl } = getAuthInputs();
  if(!email){
    showAuthError('Saisis ton email pour recevoir le lien de réinitialisation.');
    emailEl?.focus();
    return null;
  }
  if(!email.includes('@')){
    showAuthError('Email invalide : il manque probablement le @.');
    emailEl?.focus();
    return null;
  }
  clearAuthError();
  return email;
}

// ══ AUTH FONCTIONS (directement sur window) ══
window.doLogin = async function(){
  const data = validateAuthInputs('login');
  if(!data) return;
  try{
    const login = document.getElementById('btn-login');
    if(login) login.textContent = 'Connexion...';
    setAuthLoading(true);
    await auth.signInWithEmailAndPassword(data.email, data.pass);
  } catch(err){
    console.error('[AUTH LOGIN ERROR]', err);
    const m={
      'auth/invalid-credential':'Email ou mot de passe incorrect.',
      'auth/user-not-found':'Utilisateur introuvable.',
      'auth/wrong-password':'Mot de passe incorrect.',
      'auth/invalid-email':'Email invalide.',
      'auth/network-request-failed':'Problème réseau : vérifie ta connexion.'
    };
    showAuthError(m[err.code]||('Erreur connexion : '+err.message));
  } finally {
    setAuthLoading(false);
  }
};

window.resetPassword = async function(){
  const email = validateResetEmail();
  if(!email) return;
  try{
    setAuthLoading(true, 'Envoi du lien...');
    await auth.sendPasswordResetEmail(email);
    showAuthInfo('Email de réinitialisation envoyé. Vérifie ta boîte mail et tes indésirables.');
  } catch(err){
    console.error('[AUTH RESET ERROR]', err);
    const m={
      'auth/user-not-found':'Aucun compte trouvé avec cet email.',
      'auth/invalid-email':'Email invalide.',
      'auth/network-request-failed':'Problème réseau : vérifie ta connexion.'
    };
    showAuthError(m[err.code]||('Erreur réinitialisation : '+err.message));
  } finally {
    setAuthLoading(false);
  }
};

document.addEventListener('DOMContentLoaded', function(){
  const resetButton = document.getElementById('btn-reset-password');
  if(resetButton) resetButton.addEventListener('click', window.resetPassword);
});

window.doRegister = async function(){
  const data = validateAuthInputs('register');
  if(!data) return;
  try{
    setAuthLoading(true, 'Création du compte...');
    await auth.createUserWithEmailAndPassword(data.email, data.pass);
    clearAuthError();
    window.SCIapp?.toast?.('Compte créé ✓ Bienvenue !');
  } catch(err){
    console.error('[AUTH REGISTER ERROR]', err);
    const m={
      'auth/email-already-in-use':'Email déjà utilisé — utilise Se connecter.',
      'auth/weak-password':'Mot de passe trop faible.',
      'auth/invalid-email':'Email invalide.',
      'auth/operation-not-allowed':'La création de compte Email/Mot de passe n’est pas activée dans Firebase Authentication.',
      'auth/network-request-failed':'Problème réseau : vérifie ta connexion.'
    };
    showAuthError(m[err.code]||('Erreur création compte : '+err.message));
  } finally {
    setAuthLoading(false);
  }
};

window.doLogout = async function(){
  stopAll();
  Object.keys(CACHE).forEach(k=>CACHE[k]=[]);
  localStorage.removeItem('selected_sci_id');
  localStorage.removeItem('sci_seen_selector');
  await auth.signOut();
};



async function loadUserRole(){
  // V1.0.8 : résolution simple et robuste de la SCI active.
  // Source principale : users/{uid}.scis ; fallback : scis/default/members/{uid}.
  const user = auth.currentUser;
  if(!user) return 'associe';

  // V1.1.2 : default provisoire, remplacé par users/{uid}.activeSci dès lecture serveur.
  let requestedSci = 'default';

  let profile = { email:user.email };
  let scis = [];

  try{
    const userSnap = await db.collection('users').doc(user.uid).get({source:'server'});
    if(userSnap.exists){
      const d = userSnap.data() || {};
      profile = {...profile, ...d};
      if(d.activeSci && d.activeSci !== 'undefined' && d.activeSci !== 'null'){
        requestedSci = String(d.activeSci).trim();
      } else if(d.sciId && d.sciId !== 'undefined' && d.sciId !== 'null'){
        requestedSci = String(d.sciId).trim();
      }

      if(Array.isArray(d.scis) && d.scis.length){
        scis = d.scis.filter(x=>x && x.actif !== false).map(x=>({
          sciId:String(x.sciId || x.id || '').trim(),
          nom:x.nom || x.name || x.nomSCI || String(x.sciId || x.id || 'SCI'),
          role:String(x.role || 'associe').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''),
          parts:+x.parts || 0,
          actif:x.actif !== false
        })).filter(x=>x.sciId);
      }

      if(!scis.length && (d.sciId || d.role)){
        scis=[{
          sciId:d.sciId || 'default',
          nom:d.sciName || d.nomSCI || (d.sciId === 'sci_catherine' ? 'SCI Catherine' : 'SCI Claudine'),
          role:String(d.role || 'associe').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''),
          parts:+d.parts||0,
          actif:true
        }];
      }
    }
  }catch(e){ console.warn('[SCI V1.0.8] Profil users/{uid} non lu', e); }

  // Fallback vital : si users/{uid} est incomplet, on garde la base stable scis/default.
  if(!scis.length){
    try{
      const mSnap = await db.collection('scis').doc('default').collection('members').doc(user.uid).get({source:'server'});
      if(mSnap.exists){
        const m = mSnap.data() || {};
        profile = {...profile, ...m};
        scis=[{
          sciId:'default',
          nom:'SCI Claudine',
          role:String(m.role || 'associe').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''),
          parts:+m.parts || 0,
          actif:m.actif !== false
        }];
      }
    }catch(e){ console.warn('[SCI V1.0.8] Membre default non lu', e); }
  }

  if(!scis.length){
    scis=[{sciId:'default', nom:'SCI Claudine', role:'associe', parts:0, actif:true}];
    setTimeout(()=>window.SCIapp?.toast?.('Profil SCI absent : accès lecture seule.'),500);
  }

  // V1.1.1 : le GFA est une structure indépendante.
  // Il doit être ajouté explicitement dans users/{uid}.scis et scis/gfa_familial/members/{uid}.

  // Sécurité : si la SCI demandée n'est pas autorisée, retour à default si disponible, sinon première SCI.
  let current = scis.find(x=>x.sciId === requestedSci);
  if(!current){
    current = scis.find(x=>x.sciId === 'default') || scis[0];
  }

  // Vérification optionnelle du document member de la structure choisie : il peut renforcer le rôle réel.
  try{
    const memberSciId = current.sciId;
    const mSnap = await db.collection('scis').doc(memberSciId).collection('members').doc(user.uid).get({source:'server'});
    if(mSnap.exists){
      const m = mSnap.data() || {};
      if(m.actif === false){
        const fallback = scis.find(x=>x.sciId === 'default') || scis[0];
        current = fallback;
      }else{
        const memberRole = String(m.role || current.role || 'associe').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
        current = {...current, role: memberRole, parts:+m.parts || current.parts || 0, nom: current.nom || m.nomSCI || current.sciId};
      }
    }
  }catch(e){
    console.warn('[SCI V1.1.0] Vérification membre structure active impossible', current.sciId, e);
  }

  SCI_ID = current.sciId || 'default';
  // On conserve localStorage seulement comme confort visuel, jamais comme source principale.
  localStorage.setItem('selected_sci_id', SCI_ID);
  try{
    await db.collection('users').doc(user.uid).set({activeSci: SCI_ID, updatedAt: firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
  }catch(e){ console.warn('[SCI V1.1.2] activeSci non enregistré', e); }

  APP_STATE.profile = profile;
  APP_STATE.scis = scis;
  APP_STATE.currentSCI = current;
  const roleNorm = String(current.role || 'associe').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  APP_STATE.role = roleNorm === 'gerant' ? 'gerant' : 'associe';
  document.body.setAttribute('data-role', APP_STATE.role);
  applyEntityUI();
  return APP_STATE.role;
}

function applyRoleUI(){
  document.body.setAttribute('data-role', APP_STATE.role);
  applyEntityUI();
  const roleLabel = document.getElementById('account-role');
  if(roleLabel) roleLabel.textContent = APP_STATE.role === 'gerant' ? 'Gérant — modification complète' : 'Associé — lecture seule';
  refreshProfileMenu(document.getElementById('account-prenom')?.value||'', document.getElementById('account-nom')?.value||'', auth.currentUser?.email||'');
  document.querySelectorAll('.role-banner').forEach(b=>b.remove());
}
function applyWriteAccessToModal(id){
  const modal=document.getElementById(id); if(!modal) return;
  const readonly=!canWrite();
  modal.querySelectorAll('input,select,textarea').forEach(el=>{
    if(el.type==='hidden') return;
    if(id==='m-doc') el.disabled=readonly;
    else el.disabled=readonly;
  });
  modal.querySelectorAll('.btn:not(.btn-out), .btn-del').forEach(btn=>{
    if(btn.textContent.includes('Annuler')) return;
    btn.style.display=readonly?'none':'';
  });
  let note=modal.querySelector('.readonly-note-modal');
  if(readonly && !note){
    note=document.createElement('div'); note.className='readonly-note-modal readonly-note';
    note.textContent='Lecture seule : vous êtes connecté avec un profil associé.';
    modal.querySelector('.modal')?.appendChild(note);
  }
  if(!readonly && note) note.remove();
}


function toggleUserMenu(ev){
  if(ev) ev.stopPropagation();
  const menu=document.getElementById('profile-menu');
  if(menu) menu.classList.toggle('open');
}
function closeUserMenu(){
  const menu=document.getElementById('profile-menu');
  if(menu) menu.classList.remove('open');
}
document.addEventListener('click', function(ev){
  const wrap=document.querySelector('.profile-wrap');
  if(wrap && !wrap.contains(ev.target)) closeUserMenu();
});
document.addEventListener('keydown', function(ev){
  if(ev.key==='Escape') closeUserMenu();
});
function initialsFromName(name='', mail=''){
  const parts=String(name||'').trim().split(/\s+/).filter(Boolean);
  if(parts.length>=2) return (parts[0][0]+parts[1][0]).toUpperCase();
  if(parts.length===1) return parts[0].slice(0,2).toUpperCase();
  return (mail?.[0]||'U').toUpperCase();
}
function setAvatarContent(el, initials, photoUrl){
  if(!el) return;
  if(photoUrl){
    el.innerHTML=`<img src="${esc(photoUrl)}" alt="Photo de profil">`;
  }else{
    el.textContent=initials;
  }
}
function profilePhotoUrl(){
  return APP_STATE.profile?.photoUrl || auth.currentUser?.photoURL || '';
}
function refreshProfileMenu(prenom='', nom='', mail='', photoUrl=''){
  photoUrl = photoUrl || profilePhotoUrl();
  const fullName=[prenom,nom].filter(Boolean).join(' ') || (mail ? mail.split('@')[0] : 'Profil utilisateur');
  const initials=initialsFromName(fullName, mail);
  const roleText=APP_STATE.role === 'gerant' ? 'Gérant' : 'Associé';
  const roleLong=APP_STATE.role === 'gerant' ? 'Gérant — modification complète' : 'Associé — lecture seule';
  const chip=document.getElementById('role-chip');
  if(chip){
    chip.textContent=APP_STATE.role === 'gerant' ? 'Gérant' : 'Lecture seule';
    chip.className='role-chip '+APP_STATE.role;
  }
  ['avatar-btn','pm-avatar','account-photo-preview'].forEach(id=>setAvatarContent(document.getElementById(id), initials, photoUrl));
  const pmName=document.getElementById('pm-name'); if(pmName) pmName.textContent=fullName;
  const pmMail=document.getElementById('pm-mail'); if(pmMail) pmMail.textContent=mail || '—';
  const pmRole=document.getElementById('pm-role'); if(pmRole) pmRole.textContent=roleText;
  const pmSci=document.getElementById('pm-sci'); if(pmSci) pmSci.textContent=entityName();
  const roleLabel=document.getElementById('account-role'); if(roleLabel) roleLabel.textContent=roleLong;
}

async function loadAccountProfile(){
  const user = auth.currentUser;
  if(!user) return;
  let prenom='', nom='', photoUrl='';
  try{
    const snap = await db.collection('users').doc(user.uid).get();
    if(snap.exists){
      const d=snap.data()||{};
      prenom=d.prenom||''; nom=d.nom||''; photoUrl=d.photoUrl||d.avatarUrl||'';
    }
  }catch(err){ console.warn('Profil Firestore non chargé', err); }
  if((!prenom && !nom) && user.displayName){
    const parts=user.displayName.split(' ');
    prenom=parts.shift()||''; nom=parts.join(' ');
  }
  const mail=user.email||'';
  if(!photoUrl) photoUrl = user.photoURL || '';
  APP_STATE.profile = {...(APP_STATE.profile||{}), prenom, nom, email:mail, photoUrl};
  const setText=(id,val)=>{const el=document.getElementById(id); if(el) el.textContent=val;};
  const setVal=(id,val)=>{const el=document.getElementById(id); if(el) el.value=val;};
  setText('account-email', mail);
  setText('account-role', APP_STATE.role === 'gerant' ? 'Gérant — modification complète' : 'Associé — lecture seule');
  setText('account-sci', entityName());
  setVal('account-email-input', mail);
  setVal('account-prenom', prenom);
  setVal('account-nom', nom);
  setVal('account-photo-url', photoUrl);
  refreshProfileMenu(prenom, nom, mail, photoUrl);
  const greet=document.querySelector('#page-home .greeting h2');
  if(greet) greet.textContent='Bonjour, '+(prenom||mail.split('@')[0]||'')+' 👋';
}

function isDataUrlPhoto(url){
  return String(url||'').startsWith('data:image/');
}

async function uploadProfilePhotoToStorage(file){
  const user=auth.currentUser;
  if(!user) throw new Error('Aucun utilisateur connecté');
  const safeFile = await compressImageFile(file);
  const ext = (safeFile.type||'image/jpeg').includes('png') ? 'png' : 'jpg';
  const ref = storage.ref().child('avatars/'+user.uid+'/profile.'+ext);
  await ref.put(safeFile, {contentType:safeFile.type||'image/jpeg'});
  return await ref.getDownloadURL();
}

window.saveAccountInfo = async function(){
  const user=auth.currentUser;
  if(!user){ window.SCIapp?.toast('Aucun utilisateur connecté'); return; }
  const prenom=(document.getElementById('account-prenom')?.value||'').trim();
  const nom=(document.getElementById('account-nom')?.value||'').trim();
  const photoUrl=(document.getElementById('account-photo-url')?.value||'').trim();
  try{
    // Firebase Auth refuse les images base64 dans photoURL : on n'y met qu'une vraie URL courte.
    const profilePayload={displayName:[prenom,nom].filter(Boolean).join(' ')};
    if(photoUrl && !isDataUrlPhoto(photoUrl)) profilePayload.photoURL=photoUrl;
    if(!photoUrl) profilePayload.photoURL=null;
    await user.updateProfile(profilePayload);
    await db.collection('users').doc(user.uid).set({prenom,nom,email:user.email,photoUrl,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    await loadAccountProfile();
    window.SCIapp?.toast('Compte mis à jour ✓');
  }catch(err){
    console.error('Erreur profil',err);
    window.SCIapp?.toast('Erreur profil : '+err.message);
  }
};

window.handleProfilePhotoFile = async function(event){
  const file=event.target.files?.[0];
  event.target.value='';
  if(!file) return;
  if(!String(file.type||'').startsWith('image/')){ toast('Choisis une image.'); return; }
  try{
    toast('Envoi de la photo...');
    const downloadURL = await uploadProfilePhotoToStorage(file);
    sv('account-photo-url', downloadURL);
    refreshProfileMenu(v('account-prenom'), v('account-nom'), auth.currentUser?.email||'', downloadURL);
    toast('Photo envoyée. Clique sur Enregistrer pour valider.');
  }catch(err){
    console.error(err);
    toast('Erreur photo : '+(err.message||err));
  }
};
window.clearProfilePhoto = function(){
  sv('account-photo-url','');
  refreshProfileMenu(v('account-prenom'), v('account-nom'), auth.currentUser?.email||'', '');
};

// ══ AUTH STATE ══
auth.onAuthStateChanged(async user=>{
  if(user){
    try{
      document.getElementById('auth-screen').style.display='none';
      document.getElementById('app-wrapper').style.display='block';
      await loadUserRole();
      await loadAccountProfile();
      applyRoleUI();
      stopAll();
      Object.keys(CACHE).forEach(k=>CACHE[k]=[]);
      // FIX V1.0.5 : await + lecture serveur forcée
      await startListeners();
      window.SCIapp?.init();
      // V1.1.5 : après connexion, ouvrir systématiquement l'écran de choix des structures.
      // Cela limite les erreurs entre SCI Claudine, SCI Catherine et GFA familial.
      goPage('mes-scis');
    } catch(err){
      console.error('Erreur après connexion Firebase :', err);
      window.SCIapp?.toast('Erreur Firebase : ' + err.message);
    }
  } else {
    stopAll();
    document.getElementById('app-wrapper').style.display='none';
    document.getElementById('auth-screen').style.display='flex';
  }
});

// Exposer pour le script app
window.CACHE = CACHE;
window.dbSet = dbSet;
window.dbDel = dbDel;
window.SCI_DEBUG = async function(){
  const user = auth.currentUser;
  const info = {
    version:'V1.2.4 GFA design icônes',
    projectId: firebase.app().options.projectId,
    uid:user?.uid || null,
    email:user?.email || null,
    SCI_ID,
    activePath:'scis/'+activeDocId(),
    biensPath:'scis/'+activeDocId()+'/'+activeCollectionName('biens'),
    scis: APP_STATE.scis,
    currentSCI: APP_STATE.currentSCI,
    cacheCounts:Object.fromEntries(Object.keys(CACHE).map(k=>[k, CACHE[k].length]))
  };
  try{
    const snap = await db.collection('scis').doc(SCI_ID).collection('biens').get({source:'server'});
  }catch(e){ console.error('[SCI DEBUG] lecture serveur impossible', e); }
  return info;
};

// Boutons auth : gestion uniquement par onclick direct dans le HTML.

/* Inline script 2 */
const $=id=>document.getElementById(id);
const v=id=>$?($(id)?.value||''):'';
const sv=(id,val)=>{const el=$(id);if(el)el.value=val;};
const fmtDate=d=>{if(!d)return'—';return new Date(d).toLocaleDateString('fr-FR');};
function openModal(id){$(id).classList.add('open'); applyWriteAccessToModal(id);}
function closeModal(id){$(id).classList.remove('open');}
function toast(msg){const t=$('toast');if(!t)return;t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800);}
function formatFirebaseError(err){
  if(!err) return 'Erreur inconnue';
  const code=String(err.code||'');
  const msg=String(err.message||err);
  if(code==='permission-denied' || msg.includes('Missing or insufficient permissions')){
    return 'Droits insuffisants pour cette action. Vérifie que ton compte est bien gérant sur la structure active.';
  }
  if(code==='unauthenticated' || code==='auth/requires-recent-login'){
    return 'Session expirée. Déconnecte-toi puis reconnecte-toi.';
  }
  if(code==='unavailable' || code==='deadline-exceeded' || code==='auth/network-request-failed'){
    return 'Connexion Firebase indisponible. Vérifie ta connexion puis réessaie.';
  }
  if(code==='resource-exhausted'){
    return 'Quota Firebase atteint. Réessaie plus tard ou allège les documents stockés.';
  }
  if(code==='storage/unauthorized'){
    return 'Droits insuffisants pour envoyer ce fichier.';
  }
  if(code==='storage/quota-exceeded'){
    return 'Stockage Firebase plein. Supprime ou exporte des documents avant de continuer.';
  }
  if(code==='storage/retry-limit-exceeded'){
    return 'Envoi interrompu. Vérifie la connexion et réessaie.';
  }
  if(msg.toLowerCase().includes('too large') || msg.toLowerCase().includes('maximum')){
    return 'Document trop volumineux. Essaie un fichier plus léger.';
  }
  return msg || String(err);
}
async function saveWithFeedback(promise, successMsg){
  try{
    await promise;
    toast(successMsg);
    return true;
  }catch(err){
    console.error('Erreur sauvegarde Firebase', err);
    toast(formatFirebaseError(err));
    return false;
  }
}

function initTheme(){
  const t=localStorage.getItem('sci_theme')||'light';
  document.documentElement.setAttribute('data-theme',t);
  const ti=$('t-icon');if(ti)ti.textContent=t==='dark'?'🌙':'☀️';
  const tl=$('t-lbl');if(tl)tl.textContent=t==='dark'?'Mode clair':'Mode sombre';
}
function toggleTheme(){
  const t=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',t);
  localStorage.setItem('sci_theme',t);
  const ti=$('t-icon');if(ti)ti.textContent=t==='dark'?'🌙':'☀️';
  const tl=$('t-lbl');if(tl)tl.textContent=t==='dark'?'Mode clair':'Mode sombre';
}


function goComptaSection(sectionId){
  goPage('compta');
  setTimeout(()=>{
    let el=null;
    if(sectionId && sectionId!=='dashboard'){
      el=document.getElementById(sectionId);
      if(el && el.classList.contains('compta-section-card')) el.classList.add('open');
    } else {
      el=document.querySelector('#page-compta .finance-dashboard');
    }
    el?.scrollIntoView({behavior:'smooth',block:'start'});
  },80);
}

function goPage(id){
  if(isGFAContext() && id==='locataires'){ id='gfa'; }
  if(isGFAContext() && id==='home'){ id='gfa'; }
  applyEntityUI();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  let targetPage = document.getElementById('page-'+id);
  if(!targetPage){
    console.warn('[SCI Family] Page introuvable:', id);
    id = isGFAContext() ? 'gfa' : 'home';
    targetPage = document.getElementById('page-'+id) || document.getElementById('page-mes-scis');
  }
  targetPage?.classList.add('active');
  const navActiveId = (id === 'gfa') ? 'home' : id;
  document.querySelectorAll('header nav button').forEach(b=>{b.classList.toggle('active', b.dataset.page===navActiveId);});
  document.querySelectorAll('.mnav-btn').forEach(b=>b.classList.remove('active'));
  const mb=$('mn-'+id);if(mb)mb.classList.add('active');
  ({'mes-scis':renderMesSCIs,home:renderHome,gfa:renderGFA,biens:renderBiens,baux:renderBaux,locataires:renderLoc,compta:renderCompta,comptable:renderComptable,documents:renderDocs,associes:()=>{renderAssoc();renderDecisions();},echeances:renderEch,communication:renderCommunication,decisions:()=>goPage('associes'),parametres:renderParametres})[id]?.();
  applyRoleUI();
}

function estimateDocsStorageBytes(){
  const docs=window.CACHE?.docs||[];
  return docs.reduce((sum,d)=>{
    const raw=+d.size||0;
    if(d.storageMode==='firestoreChunks') return sum + Math.ceil(raw*1.38) + ((+d.chunkCount||0)*900);
    if(d.dataUrl) return sum + String(d.dataUrl).length;
    return sum + raw;
  },0);
}
function fmtBytes(n){
  n=+n||0;
  if(n>=1024*1024*1024) return (n/1024/1024/1024).toFixed(2).replace('.',',')+' Go';
  return (n/1024/1024).toFixed(1).replace('.',',')+' Mo';
}
function renderStorageUsage(){
  const limit=1024*1024*1024;
  const used=estimateDocsStorageBytes();
  const pct=Math.min(100,(used/limit)*100);
  const fill=$('storage-fill');
  if(fill){
    fill.style.width=pct.toFixed(1)+'%';
    fill.className='storage-fill '+(pct>=90?'danger':pct>=70?'warn':'');
  }
  const su=$('storage-used'); if(su) su.textContent=fmtBytes(used);
  const dc=$('storage-doc-count'); if(dc) dc.textContent=(window.CACHE?.docs||[]).length+' document(s)';
  const st=$('storage-status');
  if(st) st.textContent=pct>=90?'Presque plein':pct>=70?'Vigilance':'OK';
}
async function compressImageFile(file){
  if(!file || !String(file.type||'').startsWith('image/')) return file;
  if(file.size < 900*1024) return file;
  const img=await new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const im=new Image();
    im.onload=()=>{URL.revokeObjectURL(url); resolve(im);};
    im.onerror=()=>{URL.revokeObjectURL(url); reject(new Error('Compression image impossible'));};
    im.src=url;
  });
  const maxDim=1800;
  let {width,height}=img;
  const ratio=Math.min(1,maxDim/Math.max(width,height));
  width=Math.round(width*ratio); height=Math.round(height*ratio);
  const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0,width,height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.78));
  if(!blob) return file;
  const base=(file.name||'photo').replace(/\.[^.]+$/,'');
  return new File([blob], base+'.jpg', {type:'image/jpeg', lastModified:Date.now()});
}



function toggleComptaSection(id){
  const el=document.getElementById(id);
  if(!el) return;
  el.classList.toggle('open');
}

function renderSCISwitcher(){
  const sel=$('sci-select');
  if(!sel) return;
  const scis=APP_STATE.scis||[];
  sel.innerHTML=(scis.length?scis:[{sciId:'default',nom:'SCI Claudine'}]).map(sci=>{
    const prefix = sci.sciId === 'gfa_familial' || sci.kind === 'gfa' ? '🌳 ' : '🏢 ';
    return `<option value="${esc(sci.sciId)}">${prefix}${esc(sci.nom||sci.sciId)}</option>`;
  }).join('');
  sel.value=SCI_ID;
  sel.disabled=scis.length<=1;
  applyEntityUI();
}
window.selectSCI = async function(sciId){
  if(!sciId || sciId===SCI_ID) return;
  const allowed=(APP_STATE.scis||[]).some(s=>s.sciId===sciId);
  if(!allowed){ toast('SCI non autorisée pour ce compte'); renderSCISwitcher(); return; }
  stopAll();
  Object.keys(CACHE).forEach(k=>CACHE[k]=[]);
  SCI_ID=String(sciId);
  localStorage.setItem('selected_sci_id', SCI_ID);
  try{
    await db.collection('users').doc(auth.currentUser.uid).set({activeSci: SCI_ID, updatedAt: firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
  }catch(e){ console.warn('[SCI V1.1.2] activeSci non enregistré au changement', e); }
  await loadUserRole();
  applyRoleUI();
  renderSCISwitcher();
  await startListeners();
  toast(entityType()+' actif : '+entityName());
  goPage(isGFAContext() ? 'gfa' : 'home');
};

function renderMesSCIs(){
  renderSCISwitcher();
  const scis=APP_STATE.scis||[];
  const set=(id,val)=>{const el=$(id);if(el)el.textContent=val;};
  set('ms-scis', scis.length);
  set('ms-role', APP_STATE.role==='gerant'?'Gérant':'Associé');
  set('ms-current', APP_STATE.currentSCI?.nom || SCI_ID);
  const box=$('sci-cards'); if(!box) return;
  box.innerHTML=scis.length?scis.map(sci=>{
    const active=sci.sciId===SCI_ID;
    const role=String(sci.role||'associe').toLowerCase();
    return `<div class="sci-card ${active?'active':''}" onclick="selectSCI('${esc(sci.sciId)}')">
      <div class="sci-name">${esc(sci.nom||sci.sciId)}</div>
      <div class="sci-meta">Espace données : <strong>scis/${esc(sci.sciId)}</strong></div>
      <div class="sci-meta">Parts déclarées : <strong>${(+sci.parts||0)}%</strong></div>
      <span class="sci-role ${role==='gerant'?'gerant':''}">${role==='gerant'?'Gérant':'Associé'}</span>
      <div class="sci-actions"><button class="btn-out btn-sm" type="button">${active?'Ouverte':'Ouvrir'}</button></div>
    </div>`;
  }).join(''):'<p style="color:var(--text2);padding:20px">Aucune SCI liée à ce compte. Ajoute le champ scis dans users/{uid}.</p>';
}
function openSCISetupHelp(){
  alert('Pour ajouter une structure : crée scis/{sciId}, puis ajoute cette structure dans users/{uid}.scis et scis/{sciId}/members/{uid}. Pour le GFA, utilise sciId = gfa_familial. Les accès peuvent être les mêmes personnes que SCI Claudine, mais les données restent séparées.');
}

function renderFirebaseDiagnostics(){
  const set=(id,val)=>{const el=$(id); if(el) el.textContent=val || '—';};
  set('firebase-project-id', firebase?.app?.().options?.projectId || '—');
  set('firebase-active-sci', entityName());
  set('firebase-active-path', 'scis/'+activeDocId());
  set('firebase-current-role', APP_STATE.role==='gerant'?'Gérant':'Associé');
}
function renderParametres(){
  loadAccountProfile();
  renderStorageUsage();
  renderSCISwitcher();
  renderFirebaseDiagnostics();
  selectSettingsSection(window.__activeSettingsSection || 'account');
}

function selectSettingsSection(section){
  const meta={
    account:['Mon compte','Profil et apparence','Informations personnelles, photo de profil et thème de l’application.'],
    backup:['Sauvegardes','Données et exports','Stockage documents, sauvegarde complète, Excel, ZIP et exports CSV.'],
    access:['Sécurité & accès','Droits utilisateurs','Rappel des permissions entre gérants et associés.'],
    firebase:['Firebase','Diagnostic technique','Projet, structure active, chemin des données et cache local.'],
    danger:['Zone danger','Actions sensibles','Opérations irréversibles à utiliser uniquement en connaissance de cause.']
  };
  const key=meta[section]?section:'account';
  window.__activeSettingsSection=key;
  document.querySelectorAll('[data-settings-section]').forEach(el=>{
    el.classList.toggle('settings-section-hidden', el.dataset.settingsSection!==key);
  });
  document.querySelectorAll('.settings-tile').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.settingsTarget===key);
  });
  const [eyebrow,title,subtitle]=meta[key];
  const e=$('settings-active-eyebrow'), t=$('settings-active-title'), s=$('settings-active-subtitle');
  if(e) e.textContent=eyebrow;
  if(t) t.textContent=title;
  if(s) s.textContent=subtitle;
}

function renderGFA(){
  applyEntityUI();
  const b=window.CACHE?.biens||[], baux=window.CACHE?.baux||[], ops=window.CACHE?.ops||[], docs=window.CACHE?.docs||[], echs=window.CACHE?.echs||[];
  const rec=ops.filter(o=>o.mt>0).reduce((s,o)=>s+(+o.mt||0),0);
  const chg=ops.filter(o=>o.mt<0).reduce((s,o)=>s+Math.abs(+o.mt||0),0);
  const fermages=ops.filter(o=>String(o.cat||'').toLowerCase().includes('fermage')).length;
  const set=(id,val)=>{const el=$(id);if(el)el.textContent=val;};
  set('gfa-title', entityName());
  set('gfa-biens', b.length);
  set('gfa-net', (rec-chg).toLocaleString('fr-FR')+' €');
  set('gfa-docs', docs.length);
  set('gfa-baux', baux.length);
  set('gfa-associes', (window.CACHE?.associes||[]).length);
  set('gfa-msg', (window.CACHE?.messages||[]).length);
  const today=new Date(); today.setHours(0,0,0,0);
  set('gfa-ech', echs.filter(x=>!x.done&&new Date(x.date)<=new Date(today.getTime()+60*864e5)).length || echs.length || 0);
}


/* ══ V2.4.2 — KPI simples + graphiques accueil configurables, sans changement Firebase ══ */
const HOME_KPI_DEFS = [
  {key:'biens', icon:'🏠', title:'Biens suivis', family:'Patrimoine'},
  {key:'locataires', icon:'👤', title:'Locataires actifs', family:'Location'},
  {key:'loyers', icon:'€', title:'Loyers mensuels', family:'Revenus'},
  {key:'charges', icon:'−', title:'Charges mensuelles', family:'Charges'},
  {key:'documents', icon:'📄', title:'Documents manquants', family:'Justificatifs'},
  {key:'votes', icon:'✓', title:'Votes ouverts', family:'Décision'},
  {key:'messages', icon:'💬', title:'Messages non lus', family:'Communication'},
  {key:'echeances', icon:'⏱', title:'Échéances proches', family:'Agenda'},
  {key:'prets', icon:'🏦', title:'Mensualités estimées', family:'Prêts'},
  {key:'alertes', icon:'!', title:'Alertes à traiter', family:'Priorité'},
  {key:'cashflow', icon:'↕', title:'Cash-flow mensuel', family:'Finance'},
  {key:'patrimoine', icon:'◆', title:'Valeur patrimoine', family:'Patrimoine'},
  {key:'patrimoineNet', icon:'◇', title:'Valeur nette patrimoniale', family:'Patrimoine'},
  {key:'rentabiliteBrute', icon:'%', title:'Rentabilité brute', family:'Rendement'},
  {key:'rentabiliteNette', icon:'%', title:'Rentabilité nette', family:'Rendement'},
  {key:'endettement', icon:'≋', title:'Taux d’endettement', family:'Dette'},
  {key:'tauxOccupation', icon:'◐', title:'Taux d’occupation', family:'Location'},
  {key:'prepComptable', icon:'✓', title:'Préparation comptable', family:'Compta'},
  {key:'alertesFiscales', icon:'⚑', title:'Alertes fiscales', family:'Agenda'}
];
const DEFAULT_HOME_KPI_CONFIG = HOME_KPI_DEFS.map((k,i)=>({key:k.key, enabled:i<8}));
const HOME_CHART_DEFS = [
  {key:'quick', title:'Répartition rapide'},
  {key:'parts', title:'Répartition des parts SCI'},
  {key:'patrimoine', title:'Répartition patrimoine'},
  {key:'occupation', title:'Taux d’occupation'},
  {key:'charges', title:'Charges par catégorie'},
  {key:'flux', title:'Flux mensuels'},
  {key:'rentabiliteBiens', title:'Rentabilité par bien'}
];
const DEFAULT_HOME_CHART_CONFIG = ['quick','parts'];
function homeKpiStorageKey(){
  const uid = (window.auth && auth.currentUser && auth.currentUser.uid) ? auth.currentUser.uid : 'local';
  const sci = (typeof SCI_ID !== 'undefined' && SCI_ID) ? SCI_ID : (APP_STATE?.currentSCI?.id || 'default');
  return 'sciFamily.homeKpi.v242.'+uid+'.'+sci;
}
function homeChartStorageKey(){
  const uid = (window.auth && auth.currentUser && auth.currentUser.uid) ? auth.currentUser.uid : 'local';
  const sci = (typeof SCI_ID !== 'undefined' && SCI_ID) ? SCI_ID : (APP_STATE?.currentSCI?.id || 'default');
  return 'sciFamily.homeCharts.v242.'+uid+'.'+sci;
}
function getHomeKpiConfig(){
  try{
    const raw = localStorage.getItem(homeKpiStorageKey());
    if(!raw) return DEFAULT_HOME_KPI_CONFIG.slice();
    const parsed = JSON.parse(raw);
    const valid = Array.isArray(parsed) ? parsed.filter(x=>HOME_KPI_DEFS.some(d=>d.key===x.key)) : [];
    const missing = HOME_KPI_DEFS.filter(d=>!valid.some(x=>x.key===d.key)).map((d)=>({key:d.key,enabled:false}));
    return valid.concat(missing);
  }catch(e){ return DEFAULT_HOME_KPI_CONFIG.slice(); }
}
function setHomeKpiConfig(cfg){ localStorage.setItem(homeKpiStorageKey(), JSON.stringify(cfg)); }
function getHomeChartConfig(){
  try{
    const raw=localStorage.getItem(homeChartStorageKey());
    const arr=raw?JSON.parse(raw):DEFAULT_HOME_CHART_CONFIG;
    if(Array.isArray(arr) && arr.length>=2) return [arr[0],arr[1]].map(k=>HOME_CHART_DEFS.some(d=>d.key===k)?k:'quick');
  }catch(e){}
  return DEFAULT_HOME_CHART_CONFIG.slice();
}
function setHomeChartConfig(arr){ localStorage.setItem(homeChartStorageKey(), JSON.stringify(arr)); }
const HOME_ACTION_DEFS = [
  {key:'journal', title:'Journal comptable', desc:'Ajouter ou vérifier une opération', run:"goComptaSection('section-journal')"},
  {key:'preparation', title:'Préparation comptable', desc:'Suivre les justificatifs manquants', run:"goComptaSection('compta-preparation')"},
  {key:'documents', title:'Documents', desc:'Rechercher ou classer une pièce', run:"goPage('documents')"},
  {key:'agenda', title:'Agenda', desc:'Créer ou vérifier un rendez-vous', run:"goPage('echeances')"},
  {key:'votes', title:'Votes', desc:'Ouvrir les décisions en cours', run:"goPage('associes')"},
  {key:'messages', title:'Messages', desc:'Lire les échanges internes', run:"goPage('communication')"},
  {key:'alertes', title:'Alertes', desc:'Votes, rendez-vous et éléments à traiter', run:"openAlertsModal()", alert:true}
];
const HOME_ALERT_DEFS = [
  {key:'flagged', title:'Alertes manuelles'},
  {key:'vote', title:'Votes en attente'},
  {key:'reunion', title:'Rendez-vous agenda'},
  {key:'document', title:'Documents'},
  {key:'message', title:'Messages'}
];
const DEFAULT_HOME_ACTION_KEYS = ['journal','preparation','documents','alertes'];
const DEFAULT_HOME_ALERT_KEYS = HOME_ALERT_DEFS.map(x=>x.key);
function homePreferencesStorageKey(){
  const uid = (window.auth && auth.currentUser && auth.currentUser.uid) ? auth.currentUser.uid : 'local';
  const sci = (typeof SCI_ID !== 'undefined' && SCI_ID) ? SCI_ID : (APP_STATE?.currentSCI?.id || 'default');
  return 'sciFamily.homePrefs.v1.'+uid+'.'+sci;
}
function getHomePreferences(){
  try{
    const raw=localStorage.getItem(homePreferencesStorageKey());
    const parsed=raw?JSON.parse(raw):{};
    return {
      actions:Array.isArray(parsed.actions)?parsed.actions.filter(k=>HOME_ACTION_DEFS.some(d=>d.key===k)):DEFAULT_HOME_ACTION_KEYS.slice(),
      alerts:Array.isArray(parsed.alerts)?parsed.alerts.filter(k=>HOME_ALERT_DEFS.some(d=>d.key===k)):DEFAULT_HOME_ALERT_KEYS.slice()
    };
  }catch(e){ return {actions:DEFAULT_HOME_ACTION_KEYS.slice(),alerts:DEFAULT_HOME_ALERT_KEYS.slice()}; }
}
function setHomePreferences(prefs){ localStorage.setItem(homePreferencesStorageKey(), JSON.stringify(prefs)); }
function renderHomeQuickActions(){
  const box=document.getElementById('home-action-list'); if(!box) return;
  const prefs=getHomePreferences();
  const keys=prefs.actions.length?prefs.actions:DEFAULT_HOME_ACTION_KEYS;
  box.innerHTML=keys.map(key=>{
    const def=HOME_ACTION_DEFS.find(d=>d.key===key); if(!def) return '';
    const cls=def.alert?' home-action-alert':'';
    const end=def.alert?'<span class="alert-mini-badge" id="home-action-alert-count-2">0</span>':'<span>→</span>';
    return `<div class="home-action${cls}" onclick="${def.run}"><div><strong>${esc(def.title)}</strong><br><span>${esc(def.desc)}</span></div>${end}</div>`;
  }).join('') || '<div class="home-action"><div><strong>Aucune action</strong><br><span>Ajoute un raccourci depuis Configurer</span></div><span>→</span></div>';
}
function openHomePreferencesModal(){
  const prefs=getHomePreferences();
  const actionBox=document.getElementById('home-action-config-list');
  const alertBox=document.getElementById('home-alert-config-list');
  if(actionBox) actionBox.innerHTML=HOME_ACTION_DEFS.map(d=>`<label class="check-line"><input type="checkbox" class="home-action-pref" value="${d.key}" ${prefs.actions.includes(d.key)?'checked':''}>${esc(d.title)}<span>${esc(d.desc)}</span></label>`).join('');
  if(alertBox) alertBox.innerHTML=HOME_ALERT_DEFS.map(d=>`<label class="check-line"><input type="checkbox" class="home-alert-pref" value="${d.key}" ${prefs.alerts.includes(d.key)?'checked':''}>${esc(d.title)}</label>`).join('');
  openModal('m-home-preferences');
}
function saveHomePreferences(){
  const actions=Array.from(document.querySelectorAll('.home-action-pref:checked')).map(x=>x.value);
  const alerts=Array.from(document.querySelectorAll('.home-alert-pref:checked')).map(x=>x.value);
  if(!actions.length){ alert('Garde au moins une action rapide.'); return; }
  if(!alerts.length){ alert('Garde au moins un type d’alerte.'); return; }
  setHomePreferences({actions,alerts});
  closeModal('m-home-preferences');
  renderHomeQuickActions();
  renderHome();
  toast('Accueil personnalisé ✓');
}
function resetHomePreferences(){
  try{ localStorage.removeItem(homePreferencesStorageKey()); }catch(e){}
  openHomePreferencesModal();
  renderHomeQuickActions();
  renderHome();
}
function applyHomeKpiConfig(){
  const grid = document.querySelector('.home-kpi-grid'); if(!grid) return;
  const cfg = getHomeKpiConfig();
  let visible=0;
  cfg.forEach(item=>{
    const card = grid.querySelector('[data-kpi="'+item.key+'"]');
    if(card){
      grid.appendChild(card);
      const show = item.enabled!==false && visible<8;
      card.classList.toggle('kpi-hidden', !show);
      if(show) visible++;
    }
  });
}
function openKpiConfigModal(){
  renderKpiConfigList();
  renderChartConfigSelects();
  openModal('m-kpi-config');
}
function renderKpiConfigList(){
  const box = document.getElementById('kpi-config-list'); if(!box) return;
  const cfg = getHomeKpiConfig();
  box.innerHTML = cfg.map((item,idx)=>{
    const def = HOME_KPI_DEFS.find(d=>d.key===item.key) || HOME_KPI_DEFS[0];
    const checked = item.enabled!==false ? 'checked' : '';
    const disabled = item.enabled===false ? ' disabled' : '';
    return `<div class="kpi-config-row${disabled}" data-key="${def.key}">
      <input type="checkbox" ${checked} onchange="toggleKpiDraft('${def.key}', this.checked)">
      <div class="kpi-config-icon">${def.icon}</div>
      <div class="kpi-config-title"><strong>${def.title}</strong><span>${def.family}</span></div>
      <div class="kpi-config-actions">
        <button class="kpi-order-btn" type="button" onclick="moveKpiDraft('${def.key}',-1)">↑</button>
        <button class="kpi-order-btn" type="button" onclick="moveKpiDraft('${def.key}',1)">↓</button>
      </div>
    </div>`;
  }).join('');
}
function renderChartConfigSelects(){
  const [c1,c2]=getHomeChartConfig();
  ['chart-select-1','chart-select-2'].forEach((id,idx)=>{
    const sel=document.getElementById(id); if(!sel) return;
    sel.innerHTML=HOME_CHART_DEFS.map(d=>`<option value="${d.key}">${d.title}</option>`).join('');
    sel.value=idx===0?c1:c2;
  });
}
function readKpiDraftFromModal(){
  const rows = [...document.querySelectorAll('#kpi-config-list .kpi-config-row')];
  return rows.map(row=>({key:row.dataset.key, enabled:!!row.querySelector('input')?.checked}));
}
function toggleKpiDraft(key,checked){
  const row = document.querySelector('#kpi-config-list .kpi-config-row[data-key="'+key+'"]');
  if(row) row.classList.toggle('disabled', !checked);
}
function moveKpiDraft(key,dir){
  const box = document.getElementById('kpi-config-list'); if(!box) return;
  const row = box.querySelector('.kpi-config-row[data-key="'+key+'"]'); if(!row) return;
  if(dir<0 && row.previousElementSibling) box.insertBefore(row,row.previousElementSibling);
  if(dir>0 && row.nextElementSibling) box.insertBefore(row.nextElementSibling,row);
}
function saveKpiConfig(){
  const cfg = readKpiDraftFromModal();
  const enabledCount = cfg.filter(x=>x.enabled!==false).length;
  if(enabledCount<1){ alert('Garde au moins un KPI affiché.'); return; }
  if(enabledCount>8){ alert('Tu peux afficher au maximum 8 KPI sur l’accueil.'); return; }
  setHomeKpiConfig(cfg);
  const c1=document.getElementById('chart-select-1')?.value || 'quick';
  const c2=document.getElementById('chart-select-2')?.value || 'parts';
  setHomeChartConfig([c1,c2]);
  closeModal('m-kpi-config');
  applyHomeKpiConfig();
  renderHomeCharts();
  if(typeof toast==='function') toast('Dashboard KPI mis à jour');
}
function resetKpiConfig(){
  try{ localStorage.removeItem(homeKpiStorageKey()); localStorage.removeItem(homeChartStorageKey()); }catch(e){}
  renderKpiConfigList();
  renderChartConfigSelects();
  applyHomeKpiConfig();
  renderHomeCharts();
}
function fmtHomeMoney(v){ return (+v||0).toLocaleString('fr-FR')+' €'; }
function kpiNum(obj, keys){
  for(const k of keys){
    const v = obj && obj[k];
    if(v!==undefined && v!==null && v!=='' && !isNaN(parseFloat(String(v).replace(',','.')))) return parseFloat(String(v).replace(',','.'));
  }
  return 0;
}
function kpiText(obj, keys){ return keys.map(k=>String((obj&&obj[k])||'')).join(' '); }
function fmtKpiPct(v, ok){ return ok ? ((+v||0).toFixed(1).replace('.',',')+' %') : 'Donnée insuff.'; }
function fmtKpiMoney(v, ok){ return ok ? fmtHomeMoney(v) : 'Donnée insuff.'; }
function operationText(o){ return kpiText(o,['cat','categorie','lib','libelle','note','description','type']).toLowerCase(); }
function isLoanOperation(o){ return /pr[êe]t|credit|crédit|emprunt|mensualit|banque/.test(operationText(o)); }
function isTaxDeadline(e){ return /imp[oô]t|fiscal|cfe|taxe|foncier|d[ée]claration|liasse|is|ir/.test(kpiText(e,['titre','title','type','cat','categorie','note','description']).toLowerCase()); }
function readHomeDashboardData(){
  const b=window.CACHE?.biens||[], l=window.CACHE?.locataires||[], e=window.CACHE?.echs||[], m=window.CACHE?.messages||[], d=window.CACHE?.decisions||[], ops=window.CACHE?.ops||[], docs=window.CACHE?.docs||[], assocs=window.CACHE?.associes||[];
  const loyers=l.reduce((s,x)=>s+kpiNum(x,['loyer','loyerMensuel','rent','montantLoyer'])+kpiNum(x,['charges','provisionsCharges','chargesMensuelles']),0);
  const today=new Date(); today.setHours(0,0,0,0);
  const urg=e.filter(x=>!x.done&&x.date&&new Date(x.date)<=new Date(today.getTime()+14*864e5)).length;
  const fiscal=e.filter(x=>!x.done&&x.date&&new Date(x.date)<=new Date(today.getTime()+60*864e5)&&isTaxDeadline(x)).length;
  const pendingVotes=d.filter(x=>decisionStatus(x)==='pending').length||0;
  const rec=ops.filter(o=>(+o.mt||0)>0).reduce((s,o)=>s+(+o.mt||0),0);
  const chg=ops.filter(o=>(+o.mt||0)<0).reduce((s,o)=>s+Math.abs(+o.mt||0),0);
  const loanOps=ops.filter(isLoanOperation);
  const loansAnnual=loanOps.reduce((sum,o)=>sum+Math.abs(+o.mt||0),0);
  const monthlyCharges=Math.round(chg/12);
  const monthlyLoans=loanOps.length?Math.round(loansAnnual/12):0;
  const missing=typeof missingJustificatifs==='function' ? missingJustificatifs().length : 0;
  const docsOk=Math.max(0, ops.length-missing);
  const prepComptable = ops.length ? Math.round((docsOk/ops.length)*100) : null;
  const occupation=b.length ? Math.round(Math.min(100,(l.length/b.length)*100)) : null;
  const alertCount=typeof getPendingItems==='function' ? getPendingItems().length : 0;
  const patrimoine=b.reduce((s,x)=>s+kpiNum(x,['val','valeur','valeurEstimee','valeur_estimee','prix','montant','estimation']),0);
  const capitalRestant=ops.filter(o=>/capital restant|crd|reste du|reste à|reste a/.test(operationText(o))).reduce((sum,o)=>sum+Math.abs(+o.mt||0),0);
  const capitalForDebt=capitalRestant || loansAnnual;
  const patrimoineNet = patrimoine ? patrimoine-capitalForDebt : 0;
  const loyersAnnuels = loyers*12;
  const chargesAnnuelles = chg || monthlyCharges*12;
  const resultatAnnuel = loyersAnnuels - chargesAnnuelles - loansAnnual;
  const cashflowMensuel = loyers - monthlyCharges - monthlyLoans;
  const rentabiliteBrute = patrimoine ? (loyersAnnuels/patrimoine)*100 : null;
  const rentabiliteNette = patrimoine ? (resultatAnnuel/patrimoine)*100 : null;
  const endettement = patrimoine ? (capitalForDebt/patrimoine)*100 : null;
  return {b,l,e,m,d,ops,docs,assocs,loyers,urg,fiscal,pendingVotes,rec,chg,missing,occupation,alertCount,monthlyCharges,monthlyLoans,loansAnnual,patrimoine,patrimoineNet,capitalForDebt,loyersAnnuels,resultatAnnuel,cashflowMensuel,rentabiliteBrute,rentabiliteNette,endettement,prepComptable};
}
function renderHomeCharts(){
  const cfg=getHomeChartConfig();
  cfg.forEach((key,idx)=>{
    const el=document.getElementById('home-chart-'+(idx+1));
    if(el) el.innerHTML = buildHomeChartHTML(key);
  });
}
function buildHomeChartHTML(key){
  const data=readHomeDashboardData();
  const colors=['var(--v2-mint)','var(--v2-blue)','var(--v2-orange)','#8b6fe8','#aab4c0','#e05a4b'];
  const dot=(c='')=>`<i class="home-dot ${c}"></i>`;
  if(key==='parts'){
    const assocs=data.assocs
      .map(a=>({...a, _parts:Math.max(0,kpiNum(a,['parts','part','pourcentage','percent']))}))
      .filter(a=>a._parts>0);
    if(!assocs.length) return `<h4>Répartition des parts</h4><div class="chart-empty">Aucun associé renseigné</div>`;
    const rawTotal = assocs.reduce((sum,a)=>sum+a._parts,0);
    const isPercentTotal = rawTotal <= 100.01;
    const chartTotal = isPercentTotal ? 100 : rawTotal;
    let acc=0; const segs=[];
    assocs.forEach((a,i)=>{
      const pct = chartTotal ? (a._parts/chartTotal*100) : 0;
      const from=acc; acc+=pct;
      segs.push(`${colors[i%colors.length]} ${from}% ${Math.min(acc,100)}%`);
    });
    if(acc<99.9) segs.push(`#aab4c0 ${acc}% 100%`);
    const fmtPct=v=>(+v||0).toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1').replace('.',',')+'%';
    const leg=assocs.map((a,i)=>{
      const n=[a.prenom,a.nom].filter(Boolean).join(' ')||'Associé';
      const shown = isPercentTotal ? fmtPct(a._parts) : fmtPct((a._parts/rawTotal)*100);
      return `<div><span><i style="background:${colors[i%colors.length]}"></i>${esc(n)}</span><strong>${shown}</strong></div>`;
    }).join('') + (isPercentTotal && rawTotal<99.9 ? `<div><span><i style="background:#aab4c0"></i>Non attribué</span><strong>${fmtPct(100-rawTotal)}</strong></div>` : '');
    const center = isPercentTotal ? fmtPct(Math.min(rawTotal,100)) : '100%';
    const note = rawTotal>100.01 ? `<div class="mini-note">Parts normalisées car le total saisi dépasse 100.</div>` : '';
    return `<h4>Répartition des parts</h4><div class="mini-chart-row"><div class="mini-donut" style="background:conic-gradient(${segs.join(',')})"><b>${center}</b></div><div class="mini-legend">${leg}${note}</div></div>`;
  }
  if(key==='patrimoine'){
    const biens=data.b.filter(x=>(+x.val||0)>0);
    if(!biens.length) return `<h4>Répartition patrimoine</h4><div class="chart-empty">Aucune valeur de bien renseignée</div>`;
    const total=biens.reduce((s,x)=>s+(+x.val||0),0)||1; let acc=0; const segs=[];
    biens.forEach((b,i)=>{const p=(+b.val||0)/total*100; const from=acc; acc+=p; segs.push(`${colors[i%colors.length]} ${from}% ${acc}%`);});
    const leg=biens.map((b,i)=>`<div><span><i style="background:${colors[i%colors.length]}"></i>${esc(b.adr||b.cadastre||'Bien')}</span><strong>${Math.round((+b.val||0)/total*100)}%</strong></div>`).join('');
    return `<h4>Répartition patrimoine</h4><div class="mini-chart-row"><div class="mini-donut" style="background:conic-gradient(${segs.join(',')})"><b>${fmtHomeMoney(total)}</b></div><div class="mini-legend">${leg}</div></div>`;
  }
  if(key==='occupation'){
    return `<h4>Taux d’occupation</h4><div class="mini-gauge"><div style="--p:${data.occupation}%"><strong>${data.occupation}%</strong><span>${data.l.length} locataire(s) / ${data.b.length} bien(s)</span></div></div>`;
  }
  if(key==='charges'){
    const cats={}; data.ops.filter(o=>(+o.mt||0)<0).forEach(o=>{const k=o.cat||'Autres'; cats[k]=(cats[k]||0)+Math.abs(+o.mt||0);});
    const entries=Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,4);
    if(!entries.length) return `<h4>Charges par catégorie</h4><div class="chart-empty">Aucune charge enregistrée</div>`;
    const total=entries.reduce((s,x)=>s+x[1],0)||1; let acc=0; const segs=[];
    entries.forEach((x,i)=>{const p=x[1]/total*100; const from=acc; acc+=p; segs.push(`${colors[i%colors.length]} ${from}% ${acc}%`);});
    const leg=entries.map((x,i)=>`<div><span><i style="background:${colors[i%colors.length]}"></i>${esc(x[0])}</span><strong>${fmtHomeMoney(x[1])}</strong></div>`).join('');
    return `<h4>Charges par catégorie</h4><div class="mini-chart-row"><div class="mini-donut" style="background:conic-gradient(${segs.join(',')})"><b>${fmtHomeMoney(total)}</b></div><div class="mini-legend">${leg}</div></div>`;
  }
  if(key==='flux'){
    const vals=[['Loyers',data.loyers],['Charges',data.monthlyCharges],['Prêts',data.monthlyLoans],['Cash-flow',data.cashflowMensuel]];
    const max=Math.max(1,...vals.map(x=>Math.abs(x[1]||0)));
    const bars=vals.map((x,i)=>`<div class="mini-bar-row"><span>${x[0]}</span><div><i style="width:${Math.round(Math.abs(x[1]||0)/max*100)}%;background:${colors[i%colors.length]}"></i></div><strong>${fmtHomeMoney(x[1]||0)}</strong></div>`).join('');
    return `<h4>Flux mensuels</h4><div class="mini-bars-v3">${bars}</div>`;
  }
  if(key==='rentabiliteBiens'){
    const biens=data.b.map(b=>{
      const val=kpiNum(b,['val','valeur','valeurEstimee','valeur_estimee','prix','montant','estimation']);
      const nom=b.adr||b.cadastre||b.nom||'Bien';
      const linkedLoc=data.l.filter(l=>String(l.bienId||l.bien||l.logementId||'')===String(b.id||''));
      const loy=linkedLoc.reduce((s,l)=>s+kpiNum(l,['loyer','loyerMensuel','rent','montantLoyer']),0);
      return {nom,val,loy,rate:val?loy*12/val*100:null};
    }).filter(x=>x.val>0 && x.loy>0).slice(0,4);
    if(!biens.length) return `<h4>Rentabilité par bien</h4><div class="chart-empty">Données insuffisantes : valeur du bien + loyer lié nécessaires</div>`;
    const max=Math.max(1,...biens.map(x=>x.rate||0));
    const bars=biens.map((x,i)=>`<div class="mini-bar-row"><span>${esc(x.nom)}</span><div><i style="width:${Math.round((x.rate||0)/max*100)}%;background:${colors[i%colors.length]}"></i></div><strong>${(x.rate||0).toFixed(1).replace('.',',')}%</strong></div>`).join('');
    return `<h4>Rentabilité par bien</h4><div class="mini-bars-v3">${bars}</div>`;
  }
  return `<h4>Répartition rapide</h4><div class="mini-chart-row"><div class="home-donut"><div class="home-donut-center"><span id="home-occupation">${data.occupation}%</span><small>occup.</small></div></div><div class="home-legend"><div><span>${dot('')}Recettes</span><strong id="home-recettes">${fmtHomeMoney(data.rec)}</strong></div><div><span>${dot('blue')}Charges</span><strong id="home-charges">${fmtHomeMoney(data.chg)}</strong></div><div><span>${dot('orange')}Résultat</span><strong id="home-resultat">${fmtHomeMoney(data.rec-data.chg)}</strong></div><div><span>${dot('gray')}Justificatifs</span><strong id="home-missing-docs">${data.missing}</strong></div></div></div>`;
}

function renderHome(){
  const b=window.CACHE?.biens||[], l=window.CACHE?.locataires||[], e=window.CACHE?.echs||[], m=window.CACHE?.messages||[], d=window.CACHE?.decisions||[], ops=window.CACHE?.ops||[];
  const badge=$('current-sci-badge'); if(badge) badge.textContent=entityType()+' active : '+entityName();
  const loyers=l.reduce((s,x)=>s+(+x.loyer||0)+(+x.charges||0),0);
  const today=new Date();today.setHours(0,0,0,0);
  const urg=e.filter(x=>!x.done&&new Date(x.date)<=new Date(today.getTime()+14*864e5)).length;
  const pendingVotes=d.filter(x=>decisionStatus(x)==='pending').length||0;
  const assocCount=(window.CACHE?.associes||[]).length;
  const rec=ops.filter(o=>(+o.mt||0)>0).reduce((s,o)=>s+(+o.mt||0),0);
  const chg=ops.filter(o=>(+o.mt||0)<0).reduce((s,o)=>s+Math.abs(+o.mt||0),0);
  const missing=typeof missingJustificatifs==='function' ? missingJustificatifs().length : 0;
  const occupation=b.length ? Math.round(Math.min(100,(l.length/b.length)*100)) : 0;
  const alertCount=typeof getPendingItems==='function' ? getPendingItems().length : 0;
  const monthlyCharges=Math.round(chg/12);
  const loanOps=ops.filter(o=>/pr[êe]t|credit|crédit|emprunt|mensualit/i.test(String(o.cat||'')+' '+String(o.lib||'')+' '+String(o.note||'')));
  const loans=loanOps.reduce((sum,o)=>sum+Math.abs(+o.mt||0),0);
  const monthlyLoans=loanOps.length?Math.round(loans/12):0;
  const fmtMoney=v=>(+v||0).toLocaleString('fr-FR')+' €';
  const set=(id,v)=>{const el=$(id);if(el)el.textContent=v;};
  set('s-biens',b.length);set('s-loc',l.length);
  set('s-loyers',fmtMoney(loyers));
  set('s-charges-mensuelles',fmtMoney(monthlyCharges));set('s-prets',fmtMoney(monthlyLoans));
  set('s-urg',urg||'0');set('s-msg',m.length||'0');set('s-votes',pendingVotes||'0');set('s-docs-missing',missing||0);
  const kdata=readHomeDashboardData();
  set('s-cashflow', fmtMoney(kdata.cashflowMensuel));
  set('s-patrimoine', fmtKpiMoney(kdata.patrimoine, kdata.patrimoine>0));
  set('s-patrimoine-net', fmtKpiMoney(kdata.patrimoineNet, kdata.patrimoine>0));
  set('s-rentabilite-brute', fmtKpiPct(kdata.rentabiliteBrute, kdata.patrimoine>0 && kdata.loyersAnnuels>0));
  set('s-rentabilite-nette', fmtKpiPct(kdata.rentabiliteNette, kdata.patrimoine>0));
  set('s-endettement', fmtKpiPct(kdata.endettement, kdata.patrimoine>0 && kdata.capitalForDebt>0));
  set('s-taux-occupation', kdata.occupation===null ? 'Donnée insuff.' : (kdata.occupation+' %'));
  set('s-prep-comptable', kdata.prepComptable===null ? 'Donnée insuff.' : (kdata.prepComptable+' %'));
  set('s-alertes-fiscales', kdata.fiscal||0);
  try{ renderHomeQuickActions(); }catch(e){ console.warn('Actions rapides non rendues', e); }
  set('home-occupation',occupation+'%');set('home-alert-kpi',alertCount||0);set('home-action-alert-count',alertCount||0);set('home-action-alert-count-2',alertCount||0);
  const ac=$('home-alert-card'); if(ac) ac.classList.toggle('alert-active',alertCount>0);
  try{ applyHomeKpiConfig(); }catch(e){ console.warn('Config KPI non appliquée', e); }
  const ab=$('home-action-alert-btn'); if(ab) ab.classList.toggle('home-action-alert',alertCount>0);
  set('home-recettes',fmtMoney(rec));set('home-charges',fmtMoney(chg));set('home-resultat',fmtMoney(rec-chg));set('home-missing-docs',missing||0);try{ renderHomeCharts(); }catch(e){ console.warn('Graphiques accueil non rendus',e); }
  renderHomeAgenda(e);
  set('b-biens',b.length);set('b-loc',l.length);set('b-assoc',assocCount);
  const be=$('b-ech');if(be)be.textContent=urg||e.length; set('b-msg',m.length||0); set('b-dec',pendingVotes||0); set('b-missing-docs',missing||0);
  try{ renderHomeAlerts(); }catch(err){ console.warn('Alertes accueil non rendues',err); }
}

function renderHomeAgenda(echs){
  const box=$('home-agenda-list'); if(!box) return;
  const today=new Date(); today.setHours(0,0,0,0);
  const upcoming=(echs||[]).filter(x=>!x.done && x.date).sort((a,b)=>new Date(a.date)-new Date(b.date)).slice(0,4);
  if(!upcoming.length){ box.innerHTML='<div class="home-agenda-item"><div><strong>Aucune échéance proche</strong><br><span>Le calendrier est à jour</span></div><small>OK</small></div>'; return; }
  box.innerHTML=upcoming.map(x=>{
    const dt=new Date(x.date); dt.setHours(0,0,0,0);
    const days=Math.ceil((dt-today)/864e5);
    const label=days<0?'Retard':days===0?'Aujourd’hui':('J-'+days);
    return `<div class="home-agenda-item" onclick="goPage('echeances')"><div><strong>${esc(x.titre||x.title||x.type||'Échéance')}</strong><br><span>${esc(fmtDate(x.date))}${x.heure?' · '+esc(x.heure):''}</span></div><small>${label}</small></div>`;
  }).join('');
}

function toggleNavSub(ev,btn){
  if(ev) ev.preventDefault();
  const item=btn.closest('.nav-item'); if(!item) return false;
  document.querySelectorAll('.nav-item.open').forEach(n=>{ if(n!==item) n.classList.remove('open'); });
  item.classList.toggle('open');
  return false;
}
document.addEventListener('click',function(e){
  if(!e.target.closest('.nav-item')) document.querySelectorAll('.nav-item.open').forEach(n=>n.classList.remove('open'));
});

// V2.3 — lorsqu’un menu déroulant est ouvert, le fait de passer sur un autre menu
// referme automatiquement l’ancien menu. Cela évite que Locataires reste affiché
// quand on survole ensuite Comptabilité, Documents, etc.
document.addEventListener('DOMContentLoaded',function(){
  document.querySelectorAll('.main-nav .nav-item').forEach(item=>{
    item.addEventListener('mouseenter',function(){
      document.querySelectorAll('.main-nav .nav-item.open').forEach(openItem=>{
        if(openItem!==item) openItem.classList.remove('open');
      });
    });
  });
});

function fillBailSelects(bail={}){
  const parc=$('bail-parcelle');
  if(parc) parc.innerHTML='<option value="">— Aucune parcelle —</option>'+(window.CACHE?.biens||[]).map(b=>`<option value="${esc(b.id)}">${esc((b.cadastre||b.adr||'Parcelle')+' · '+(b.commune||''))}</option>`).join('');
  const doc=$('bail-doc');
  if(doc) doc.innerHTML='<option value="">— Aucun document —</option>'+(window.CACHE?.docs||[]).map(d=>`<option value="${esc(d.id)}">${esc(d.name||'Document')} · ${esc(d.type||'doc')}</option>`).join('');
  if(parc) parc.value=bail.parcelleId||'';
  if(doc) doc.value=bail.docId||'';
}
function bailParcelleLabel(id){
  const b=(window.CACHE?.biens||[]).find(x=>String(x.id)===String(id));
  return b ? (b.cadastre||b.adr||'Parcelle') : '—';
}
function bailDocLabel(id){
  const d=(window.CACHE?.docs||[]).find(x=>String(x.id)===String(id));
  return d ? (d.name||'Document') : '—';
}
function renderBaux(){
  if(!isGFAContext()){ goPage('home'); return; }
  const rows=(window.CACHE?.baux||[]).sort((a,b)=>String(a.fin||'').localeCompare(String(b.fin||'')));
  const tb=$('baux-table'); if(!tb) return;
  tb.innerHTML=rows.length?rows.map(b=>`<tr>
    <td>${esc(b.fermier||'—')}</td><td>${esc(bailParcelleLabel(b.parcelleId))}</td><td><span class="tag tg">${esc(b.type||'Bail rural')}</span></td>
    <td>${fmtDate(b.debut)}</td><td>${fmtDate(b.fin)}</td><td class="apos">${(+b.fermage||0).toLocaleString('fr-FR')} €</td><td>${esc(b.indexation||'—')}</td>
    <td>${b.docId?`<button class="btn-out btn-sm" onclick="event.stopPropagation();openStoredDoc(${b.docId})">${esc(bailDocLabel(b.docId))}</button>`:'—'}</td>
    <td><div class="td-act"><button class="ico-btn write-only" onclick="openBailModal('${String(b.id)}')">✏️</button><button class="ico-btn write-only" onclick="confirmDel('bail-direct','${String(b.id)}')">🗑</button></div></td>
  </tr>`).join(''):'<tr><td colspan="9" style="color:var(--text2);text-align:center;padding:18px">Aucun bail rural enregistré.</td></tr>';
}
function openBailModal(id){
  if(!canWrite()){ denyWrite(); return; }
  const e=id!=null, b=e?(window.CACHE?.baux||[]).find(x=>String(x.id)===String(id)):null;
  $('mbail-t').innerHTML=e?'📜 Modifier le bail rural &nbsp;<span class="mbadge">Édition</span>':'📜 Nouveau bail rural';
  $('bail-del').style.display=e?'block':'none';
  fillBailSelects(b||{});
  sv('bail-id',b?.id||''); sv('bail-fermier',b?.fermier||''); sv('bail-parcelle',b?.parcelleId||''); sv('bail-type',b?.type||'Bail rural 9 ans'); sv('bail-fermage',b?.fermage||''); sv('bail-debut',b?.debut||''); sv('bail-fin',b?.fin||''); sv('bail-indexation',b?.indexation||'Indice national des fermages'); sv('bail-doc',b?.docId||''); sv('bail-notes',b?.notes||'');
  openModal('m-bail');
}
async function saveBail(){
  if(!canWrite()){ denyWrite(); return; }
  const id=v('bail-id'), e=!!id;
  const obj={id:e?id:Date.now(),fermier:v('bail-fermier'),parcelleId:v('bail-parcelle'),type:v('bail-type'),fermage:+v('bail-fermage')||0,debut:v('bail-debut'),fin:v('bail-fin'),indexation:v('bail-indexation'),docId:v('bail-doc'),notes:v('bail-notes')};
  const ok=await saveWithFeedback(window.dbSet?.('baux',obj), e?'Bail rural mis à jour ✓':'Bail rural ajouté ✓');
  if(ok) closeModal('m-bail');
}

function renderBiens(){
  const title=document.querySelector('#page-biens .sec-hdr h2');
  const sub=document.querySelector('#page-biens .sec-hdr p');
  const addBtn=document.querySelector('#page-biens .sec-hdr .btn');
  if(title) title.textContent = isGFAContext() ? 'Parcelles du GFA' : 'Biens de la SCI';
  if(sub) sub.textContent = isGFAContext() ? '🌾 Enregistrez les parcelles : commune, cadastre, surface, nature du sol, exploitant et bail lié.' : '✏️ Cliquez sur une carte pour modifier';
  if(addBtn) addBtn.textContent = isGFAContext() ? '+ Ajouter une parcelle' : '+ Ajouter';
  const list=window.CACHE?.biens||[];
  const box=$('biens-list'); if(!box) return;
  if(isGFAContext()){
    box.innerHTML=list.length?list.map(b=>`
    <div class="card" onclick="openBienModal(${b.id})">
      <div class="edit-hint">✏️ Cliquer pour modifier</div>
      <div class="card-hd"><div><div class="card-title">${esc(b.cadastre||b.adr||'Parcelle')}</div><div class="card-sub">${esc(b.commune||'Commune non renseignée')} · ${esc(b.nature||b.type||'Nature non renseignée')}</div></div><span class="tag tg">GFA</span></div>
      <div class="divider"></div>
      <div class="info-row"><span>Surface</span><span>${b.surf?b.surf+' ha':'—'}</span></div>
      <div class="info-row"><span>Exploitant</span><span>${esc(b.exploitant||'—')}</span></div>
      <div class="info-row"><span>Type de bail</span><span>${esc(b.typeBail||'—')}</span></div>
      <div class="info-row"><span>Valeur estimée</span><span>${(+b.val||0).toLocaleString('fr-FR')} €</span></div>
      ${b.notes?`<div class="note-box">📝 ${esc(b.notes)}</div>`:''}
      ${linkedDocsHTML(b)}
    </div>`).join(''):'<p style="color:var(--text2);padding:20px">Aucune parcelle enregistrée.</p>';
    return;
  }
  box.innerHTML=list.length?list.map(b=>`
    <div class="card" onclick="openBienModal(${b.id})">
      <div class="edit-hint">✏️ Cliquer pour modifier</div>
      <div class="card-hd"><div><div class="card-title">${b.adr}</div><div class="card-sub">${b.type} · ${b.surf} m²</div></div>
      <span class="tag ${b.stat==='Loué'?'tg':b.stat==='Vacant'?'tr':'to'}">${b.stat}</span></div>
      <div class="divider"></div>
      <div class="info-row"><span>Valeur estimée</span><span>${(b.val||0).toLocaleString('fr-FR')} €</span></div>
      <div class="info-row"><span>Loyer mensuel</span><span>${(b.loyer||0).toLocaleString('fr-FR')} €</span></div>
      <div class="info-row"><span>DPE</span><span class="tag tb">${b.dpe}</span></div>
      ${b.notes?`<div class="info-row"><span>Notes</span><span style="color:var(--text2);font-size:12px">${b.notes}</span></div>`:''}
      <div class="divider"></div>
      <div style="font-size:12px;color:var(--text2)">Rendement brut</div>
      <div class="progress"><div class="progress-bar" style="width:${b.val?Math.min((b.loyer*12/b.val*100)*2,100).toFixed(0):0}%"></div></div>
      <div style="font-size:12px;color:var(--gold);margin-top:4px">${b.val?(b.loyer*12/b.val*100).toFixed(2):'—'} % / an</div>
      ${linkedDocsHTML(b)}
    </div>`).join(''):'<p style="color:var(--text2);padding:20px">Aucun bien enregistré.</p>';
}

function renderLoc(){
  const list=window.CACHE?.locataires||[];
  $('loc-list').innerHTML=list.length?list.map(l=>`
    <div class="card" onclick="openLocataireModal(${l.id})">
      <div class="edit-hint">✏️ Cliquer pour modifier</div>
      <div class="card-hd"><div><div class="card-title">${l.prenom} ${l.nom}</div><div class="card-sub">${l.bien||'—'}</div></div>
      <span class="tag tg">Actif</span></div>
      <div class="divider"></div>
      <div class="info-row"><span>Loyer + charges</span><span>${l.loyer} + ${l.charges} €</span></div>
      <div class="info-row"><span>Bail</span><span>${fmtDate(l.entree)} → ${fmtDate(l.fin)}</span></div>
      <div class="info-row"><span>Dépôt</span><span>${l.depot} €</span></div>
      <div class="info-row"><span>IBAN</span><span style="font-size:11px;font-family:monospace">${l.iban||'—'}</span></div>
      ${l.note?`<div class="note-box">📝 ${l.note}</div>`:''}
      <div class="divider"></div>
      <div class="card-acts" onclick="event.stopPropagation()">
        <a href="tel:${l.tel}" class="act-call">📞 Appeler</a>
        <a href="mailto:${l.email}" class="act-mail">✉️ Email</a>
        <button class="act-edit write-only" onclick="genQuittanceFromLoc(${l.id})">🧾 Quittance</button>
      </div>
    </div>`).join(''):'<p style="color:var(--text2);padding:20px">Aucun locataire.</p>';
}

function renderAssocPie(){
  const assocs=(window.CACHE?.associes||[]).filter(a=>(+a.parts||0)>0);
  const pie=$('assoc-pie'), leg=$('assoc-legend');
  if(!pie||!leg) return;
  const colors=['var(--gold)','var(--blue)','var(--green)','var(--red)','var(--text3)','var(--gold2)'];
  if(!assocs.length){ pie.style.background='var(--surface2)'; leg.innerHTML='<div class="doc-meta">Aucun associé renseigné</div>'; return; }
  let acc=0;
  const segs=assocs.map((a,i)=>{const p=Math.max(0,+a.parts||0); const from=acc; acc+=p; return `${colors[i%colors.length]} ${from}% ${Math.min(acc,100)}%`;});
  if(acc<100) segs.push(`var(--text3) ${acc}% 100%`);
  pie.style.background=`conic-gradient(${segs.join(',')})`;
  leg.innerHTML=assocs.map((a,i)=>{const n=[a.prenom,a.nom].filter(Boolean).join(' ')||'Associé';return `<div class="leg"><div class="leg-dot" style="background:${colors[i%colors.length]}"></div>${esc(n)} — ${(+a.parts||0)}%</div>`}).join('')+(acc<100?`<div class="leg"><div class="leg-dot" style="background:var(--text3)"></div>Non attribué — ${(100-acc).toFixed(1).replace('.0','')}%</div>`:'');
}
function csvEscape(x){ return '"'+String(x??'').replace(/"/g,'""')+'"'; }
function downloadTextFile(filename, content, type='text/csv;charset=utf-8;'){
  const blob=new Blob(['\ufeff'+content],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportComptaCSV(){
  const ops=window.CACHE?.ops||[], docs=window.CACHE?.docs||[];
  const header=['Date','Libelle','Bien','Categorie','Type','Recette','Charge','Montant signe','Paiement','Statut','Justificatif','ID Justificatif'];
  const rows=ops.map(o=>{
    const mt=+o.mt||0, d=docs.find(x=>String(x.id)===String(o.docId||''));
    return [o.date||'',o.lib||'',o.bien||'',o.cat||'',mt>=0?'recette':'charge',mt>0?String(mt).replace('.',','):'',mt<0?String(Math.abs(mt)).replace('.',','):'',String(mt).replace('.',','),o.payment||'',o.status||'',d?.name||'',o.docId||''];
  });
  const csv=[header,...rows].map(r=>r.map(csvEscape).join(';')).join('\n');
  downloadTextFile('comptabilite-sci-family.csv',csv);
  toast('Export CSV amélioré créé ✓');
}
function exportComptaXLS(){
  const ops=window.CACHE?.ops||[], docs=window.CACHE?.docs||[];
  const rows=ops.map(o=>{
    const mt=+o.mt||0, d=docs.find(x=>String(x.id)===String(o.docId||''));
    const rowClass=mt>=0?'recette':'charge';
    return `<tr class="${rowClass}"><td>${esc(o.date||'')}</td><td>${esc(o.lib||'')}</td><td>${esc(o.bien||'')}</td><td>${esc(o.cat||'')}</td><td>${mt>=0?'Recette':'Charge'}</td><td>${mt>0?mt.toLocaleString('fr-FR'):''}</td><td>${mt<0?Math.abs(mt).toLocaleString('fr-FR'):''}</td><td>${esc(o.payment||'')}</td><td>${esc(o.status||'')}</td><td>${esc(d?.name||'')}</td></tr>`;
  }).join('');
  const html=`<html><head><meta charset="utf-8"><style>table{border-collapse:collapse;font-family:Arial}th{background:#1f2937;color:white;padding:8px;border:1px solid #999}td{padding:7px;border:1px solid #ccc}.recette td{background:#eaf3ff}.charge td{background:#fff0f0}.recette td:nth-child(6){color:#0066cc;font-weight:bold}.charge td:nth-child(7){color:#c0392b;font-weight:bold}

  /* ═══════════════════════════════════════════════════════════════
     SCI Family V1.1.1 — GFA séparé + code couleur structures
     ═══════════════════════════════════════════════════════════════ */
  :root{--entity:#c9a84c;--entity2:#e8c97a;--entitySoft:rgba(201,168,76,.12);--entityBorder:rgba(201,168,76,.35);}
  body[data-entity="default"]{--entity:#4caf82;--entity2:#9ed9b8;--entitySoft:rgba(76,175,130,.12);--entityBorder:rgba(76,175,130,.35);}
  body[data-entity="sci_catherine"]{--entity:#5aa1df;--entity2:#9bc8ef;--entitySoft:rgba(90,161,223,.13);--entityBorder:rgba(90,161,223,.42);}
  body[data-entity="gfa_familial"]{--entity:#7a8f45;--entity2:#c1d37a;--entitySoft:rgba(122,143,69,.14);--entityBorder:rgba(122,143,69,.42);}
  body[data-entity="other"]{--entity:#c9a84c;--entity2:#e8c97a;--entitySoft:rgba(201,168,76,.12);--entityBorder:rgba(201,168,76,.35);}
  .logo-icon,.avatar-btn,.pm-avatar{background:linear-gradient(135deg,var(--entity),var(--entity2)) !important;}
  .sci-switcher{min-width:210px;border-color:var(--entityBorder);background:var(--entitySoft);}
  .sci-switcher label{display:none;}
  .sci-switcher::before{content:'';width:12px;height:12px;border-radius:50%;background:var(--entity);box-shadow:0 0 0 6px var(--entitySoft);flex:0 0 auto;margin-left:4px;}
  .sci-switcher select{font-size:14px;font-weight:800;cursor:pointer;}
  .current-entity-name{display:inline-flex;align-items:center;gap:9px;border:1px solid var(--entityBorder);background:var(--entitySoft);border-radius:999px;padding:9px 13px;font-size:13px;font-weight:900;color:var(--text);white-space:nowrap;}
  .current-entity-name::before{content:'';width:10px;height:10px;border-radius:50%;background:var(--entity);box-shadow:0 0 0 5px var(--entitySoft);}
  .role-chip{display:none !important;}
  .theme-btn{display:none !important;}
  .role-banner{display:none !important;}
  header nav.main-nav{gap:6px;align-items:center;justify-content:center;flex:1;max-width:none;}
  header nav.main-nav .nav-sep{width:1px;height:24px;background:var(--border);margin:0 4px;opacity:.8;}
  header nav.main-nav button{padding:9px 11px;font-size:13px;white-space:nowrap;}
  header nav.main-nav button.active{background:var(--entitySoft);color:var(--entity);}
  .structure-mini{background:var(--entitySoft);border:1px solid var(--entityBorder);border-radius:18px;padding:18px 20px;margin-bottom:22px;display:flex;align-items:center;gap:14px;}
  .structure-mini-dot{width:38px;height:38px;border-radius:14px;background:var(--entity);box-shadow:0 0 0 8px var(--entitySoft);flex-shrink:0;}
  .structure-mini h3{font-family:'Playfair Display',serif;font-size:24px;margin-bottom:2px;}
  .structure-mini p{color:var(--text2);font-size:13px;line-height:1.35;}
  .gfa-panel{background:linear-gradient(135deg,var(--entitySoft),rgba(201,168,76,.06));border:1px solid var(--entityBorder);border-radius:var(--r);padding:22px;margin-bottom:22px;box-shadow:var(--shadow);}
  .gfa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;}
  .gfa-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;cursor:pointer;transition:.2s;}
  .gfa-card:hover{border-color:var(--entity);background:var(--surface2);transform:translateY(-2px);}
  .gfa-card strong{display:block;font-family:'Playfair Display',serif;font-size:24px;color:var(--entity);margin:5px 0;}
  .gfa-card span{font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--text3);font-weight:800;}
  .gfa-card p{font-size:12px;color:var(--text2);line-height:1.45;margin-top:6px;}
  @media(min-width:1025px){header{gap:18px}.hdr-right{flex-shrink:0}.logo{min-width:260px}header nav.main-nav{flex-wrap:wrap}.current-entity-name{display:flex}.sci-switcher{min-width:220px}}
  @media(max-width:1024px){header nav.main-nav{display:none}.current-entity-name{display:none}.sci-switcher{display:flex}.role-banner{display:none!important}}
  @media(max-width:640px){.structure-mini{padding:14px;margin-bottom:16px}.structure-mini h3{font-size:20px}.structure-mini p{font-size:12px}.gfa-panel{padding:16px}.gfa-grid{grid-template-columns:1fr}.sci-switcher{display:none!important}}

  /* ══ V1.1.3 — Module GFA foncier opérationnel ══ */
  .gfa-module-panel{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:22px;margin-bottom:22px;box-shadow:var(--shadow);}
  .gfa-module-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px;}
  .gfa-module-head h3{font-family:'Playfair Display',serif;font-size:24px;margin-bottom:4px;}
  .gfa-module-head p{color:var(--text2);font-size:13px;line-height:1.45;}
  .gfa-baux-table .tag{white-space:nowrap;}
  .gfa-focus-card.is-disabled{opacity:.72;cursor:default;}
  body[data-entity="gfa_familial"] #doc-filters .btn-out{border-color:rgba(122,143,69,.28);}
  body[data-entity="gfa_familial"] .finance-dashboard{background:linear-gradient(135deg,rgba(122,143,69,.14),rgba(201,168,76,.05));border-color:rgba(122,143,69,.30);}
  @media(max-width:640px){.gfa-module-head{flex-direction:column}.gfa-module-head .btn{width:100%;}}

  /* V1.2.1 — navigation + associés compacts */
  body[data-entity="gfa_familial"] header nav.main-nav-general button[data-sci-only="locataires"],
  body[data-entity="gfa_familial"] .mobile-nav .mnav-btn[data-sci-only="locataires"]{display:none!important;}
  #page-associes .cards{grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;}
  #page-associes #assoc-list .card{padding:14px 16px;border-radius:14px;}
  #page-associes #assoc-list .card .edit-hint{display:none;}
  #page-associes #assoc-list .card-hd{margin-bottom:8px;}
  #page-associes #assoc-list .divider{margin:8px 0;}
  #page-associes #assoc-list .info-row{font-size:12px;margin-bottom:4px;}
  #page-associes #assoc-list .progress{height:4px;margin-top:4px;}
  #page-associes #assoc-list .card-acts{margin-top:9px;}
  #page-associes #assoc-list .card-acts a{padding:7px;font-size:11px;}
  #page-associes #assoc-list .card-title{font-size:14px;}
  #page-associes #assoc-list .card-sub{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;}


  /* ── COMPTABILITÉ V1.2.2 : sections ouvrables ── */
  .compta-section-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);margin:18px 0;box-shadow:var(--shadow);overflow:hidden;}
  .compta-section-head{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:22px 24px;cursor:pointer;background:linear-gradient(135deg,rgba(201,168,76,.08),rgba(255,255,255,.02));transition:.2s;}
  .compta-section-head:hover{background:var(--surface2);border-color:var(--gold);}
  .compta-section-title{display:flex;align-items:center;gap:14px;min-width:0;}
  .compta-section-icon{width:44px;height:44px;border-radius:14px;background:rgba(201,168,76,.14);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;}
  .compta-section-title h3{font-family:'Playfair Display',serif;font-size:22px;margin:0;}
  .compta-section-title p{font-size:13px;color:var(--text2);line-height:1.45;margin-top:3px;}
  .compta-section-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;}
  .compta-mini-badge{background:var(--surface2);border:1px solid var(--border);border-radius:999px;padding:7px 11px;font-size:12px;color:var(--text2);font-weight:700;}
  .compta-chevron{font-size:18px;color:var(--gold);transition:.2s;}
  .compta-section-card.open .compta-chevron{transform:rotate(180deg);}
  .compta-section-body{display:none;padding:0 24px 24px;}
  .compta-section-card.open .compta-section-body{display:block;}
  .compta-quick-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:4px 0 16px;}
  .compta-quick-kpis .stat-card{padding:14px 16px;min-height:auto;}
  .compta-quick-kpis .stat-val{font-size:24px;}
  @media(max-width:760px){.compta-section-head{align-items:flex-start;flex-direction:column;padding:18px}.compta-section-meta{justify-content:flex-start}.compta-section-body{padding:0 18px 18px}.compta-quick-kpis{grid-template-columns:1fr}.compta-section-title h3{font-size:20px}}


/* ══ V2.4.1 — Personnalisation légère des KPI accueil ══ */
.kpi-config-btn{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(47,110,203,.20);background:linear-gradient(135deg,rgba(255,255,255,.84),rgba(236,245,255,.88));color:var(--v2-blue,#2f6ecb);border-radius:14px;padding:10px 14px;font-weight:800;font-family:var(--font-body,'DM Sans',sans-serif);cursor:pointer;box-shadow:0 8px 22px rgba(47,110,203,.08);transition:.2s;}
.kpi-config-btn:hover{transform:translateY(-1px);border-color:rgba(47,110,203,.42);box-shadow:0 12px 28px rgba(47,110,203,.14);}
[data-theme="dark"] .kpi-config-btn{background:linear-gradient(135deg,rgba(230,189,99,.14),rgba(7,26,58,.72));border-color:rgba(230,189,99,.25);color:#e6bd63;}
.kpi-config-panel{display:grid;gap:10px;margin-top:6px;}
.kpi-config-row{display:grid;grid-template-columns:34px 42px 1fr auto;align-items:center;gap:10px;background:var(--inp,var(--surface2));border:1px solid var(--border);border-radius:14px;padding:10px 12px;}
.kpi-config-row.disabled{opacity:.48;}
.kpi-config-row input{width:18px;height:18px;accent-color:var(--v2-blue,#2f6ecb);}
.kpi-config-icon{width:34px;height:34px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:rgba(47,110,203,.10);font-weight:900;}
.kpi-config-title strong{display:block;font-size:13px;}
.kpi-config-title span{display:block;color:var(--text2);font-size:11px;margin-top:2px;}
.kpi-config-actions{display:flex;gap:6px;}
.kpi-order-btn{border:1px solid var(--border);background:var(--surface);color:var(--text2);border-radius:10px;width:32px;height:32px;cursor:pointer;font-weight:900;}
.kpi-order-btn:hover{border-color:var(--v2-blue,#2f6ecb);color:var(--v2-blue,#2f6ecb);}
.kpi-config-help{background:rgba(47,110,203,.08);border:1px solid rgba(47,110,203,.16);border-radius:14px;padding:11px 13px;color:var(--text2);font-size:12px;line-height:1.45;margin-bottom:12px;}
.kpi-hidden{display:none!important;}
@media(max-width:640px){.home-kpi-head .kpi-config-btn{width:100%;justify-content:center}.kpi-config-row{grid-template-columns:30px 36px 1fr}.kpi-config-actions{grid-column:1 / -1;justify-content:flex-end}.kpi-config-icon{width:32px;height:32px}}

</style></head><body><table><thead><tr><th>Date</th><th>Libellé</th><th>Bien</th><th>Catégorie</th><th>Type</th><th>Recette</th><th>Charge</th><th>Paiement</th><th>Statut</th><th>Justificatif</th></tr></thead><tbody>${rows||'<tr><td colspan="10">Aucune opération</td></tr>'}</tbody></table></body></html>`;
  downloadTextFile('comptabilite-sci-family.xls',html,'application/vnd.ms-excel;charset=utf-8;');
  toast('Export Excel stylé créé ✓');
}
function parseCSVLine(line){
  const out=[]; let cur='', q=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){
      if(q && line[i+1]==='"'){cur+='"'; i++;}
      else q=!q;
    }else if((c===';'||c===',') && !q){ out.push(cur.trim()); cur=''; }
    else cur+=c;
  }
  out.push(cur.trim()); return out;
}
function parseCSVText(text){
  const lines=String(text||'').replace(/^\ufeff/,'').split(/\r?\n/).filter(l=>l.trim());
  if(!lines.length) return [];
  const headers=parseCSVLine(lines[0]).map(h=>h.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''));
  return lines.slice(1).map(line=>{
    const vals=parseCSVLine(line), obj={};
    headers.forEach((h,i)=>obj[h]=vals[i]??'');
    return obj;
  });
}
function numFR(x){
  const n=String(x??'').replace(/\s/g,'').replace(',', '.');
  const v=parseFloat(n); return isNaN(v)?0:v;
}
async function readTextFile(file){ return await new Promise((res,rej)=>{const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsText(file,'utf-8');}); }
async function importOpsCSV(event){
  const file=event.target.files?.[0]; event.target.value='';
  if(!file) return; if(!canWrite()){ denyWrite(); return; }
  try{
    const rows=parseCSVText(await readTextFile(file));
    if(!rows.length){ toast('CSV vide'); return; }
    if(!confirm('Importer '+rows.length+' opération(s) dans la comptabilité ?')) return;
    let count=0;
    for(const r of rows){
      const recette=numFR(r.recette), charge=numFR(r.charge);
      let mt = recette ? recette : (charge ? -Math.abs(charge) : numFR(r['montant signe']||r.montant));
      const type=(r.type||'').toLowerCase().includes('charge') || mt<0 ? 'charge' : 'recette';
      if(type==='charge') mt=-Math.abs(mt); else mt=Math.abs(mt);
      await window.dbSet?.('ops',{id:Date.now()+count,date:r.date||new Date().toISOString().split('T')[0],lib:r.libelle||r['libellé']||'',bien:r.bien||'',cat:r.categorie||r['catégorie']||'Autre',type,payment:r.paiement||'',status:r.statut||'paye',docId:r['id justificatif']||'',mt});
      count++;
    }
    toast(count+' opération(s) importée(s) ✓');
  }catch(err){ console.error(err); toast('Erreur import CSV : '+(err.message||err)); }
}
function exportBudgetCSV(){
  const budgets=window.CACHE?.budgets||[];
  const header=['Annee','Type','Poste','Categorie','Montant','Notes'];
  const rows=budgets.map(b=>[b.year||'',b.type||'',b.lib||'',b.cat||'',String(b.mt||0).replace('.',','),b.notes||'']);
  const csv=[header,...rows].map(r=>r.map(csvEscape).join(';')).join('\n');
  downloadTextFile('budget-previsionnel-sci-family.csv',csv);
  toast('Export budget créé ✓');
}
async function importBudgetCSV(event){
  const file=event.target.files?.[0]; event.target.value='';
  if(!file) return; if(!canWrite()){ denyWrite(); return; }
  try{
    const rows=parseCSVText(await readTextFile(file));
    if(!rows.length){ toast('CSV budget vide'); return; }
    if(!confirm('Importer '+rows.length+' ligne(s) de budget ?')) return;
    let count=0;
    for(const r of rows){
      const type=(r.type||'charge').toLowerCase().includes('recette')?'recette':'charge';
      await window.dbSet?.('budgets',{id:Date.now()+count,year:+(r.annee||r['année']||new Date().getFullYear()),type,lib:r.poste||r.libelle||r['libellé']||'',cat:r.categorie||r['catégorie']||'Autre',mt:numFR(r.montant),notes:r.notes||''});
      count++;
    }
    toast(count+' ligne(s) de budget importée(s) ✓');
  }catch(err){ console.error(err); toast('Erreur import budget : '+(err.message||err)); }
}


function selectedBudgetYear(){
  const y=+$('budget-year')?.value || new Date().getFullYear();
  return y;
}
function fillBudgetYears(){
  const sel=$('budget-year'); if(!sel) return;
  const now=new Date().getFullYear();
  const years=new Set([now-1,now,now+1,...(window.CACHE?.budgets||[]).map(b=>+b.year).filter(Boolean)]);
  const current=sel.value || String(now);
  sel.innerHTML=Array.from(years).sort((a,b)=>b-a).map(y=>`<option value="${y}">${y}</option>`).join('');
  sel.value=years.has(+current)?current:String(now);
}
function calcActualByCat(year, cat, type){
  return (window.CACHE?.ops||[]).filter(o=>{
    const y=o.date?new Date(o.date).getFullYear():0;
    if(y!==+year) return false;
    if(cat && o.cat!==cat) return false;
    return type==='recette' ? (+o.mt||0)>0 : (+o.mt||0)<0;
  }).reduce((s,o)=>s+Math.abs(+o.mt||0),0);
}
function renderBudget(){
  fillBudgetYears();
  const year=selectedBudgetYear();
  const rows=(window.CACHE?.budgets||[]).filter(b=>+b.year===+year);
  const rec=rows.filter(b=>b.type==='recette').reduce((s,b)=>s+(+b.mt||0),0);
  const chg=rows.filter(b=>b.type==='charge').reduce((s,b)=>s+(+b.mt||0),0);
  const realRec=(window.CACHE?.ops||[]).filter(o=>new Date(o.date).getFullYear()===+year && (+o.mt||0)>0).reduce((s,o)=>s+(+o.mt||0),0);
  const realChg=(window.CACHE?.ops||[]).filter(o=>new Date(o.date).getFullYear()===+year && (+o.mt||0)<0).reduce((s,o)=>s+Math.abs(+o.mt||0),0);
  const set=(id,val)=>{const el=$(id);if(el)el.textContent=val;};
  set('bp-rec',rec.toLocaleString('fr-FR')+' €');
  set('bp-chg',chg.toLocaleString('fr-FR')+' €');
  set('bp-net',(rec-chg).toLocaleString('fr-FR')+' €');
  set('bp-ecart',((realRec-realChg)-(rec-chg)).toLocaleString('fr-FR')+' €');
  const bc=$('budget-count'); if(bc) bc.textContent=rows.length+' ligne'+(rows.length>1?'s':'');
  const tb=$('budget-table'); if(!tb) return;
  tb.innerHTML=rows.length?rows.sort((a,b)=>String(a.type).localeCompare(String(b.type))||String(a.cat).localeCompare(String(b.cat))).map(b=>{
    const real=calcActualByCat(year,b.cat,b.type);
    const ecart=b.type==='recette' ? real-(+b.mt||0) : (+b.mt||0)-real;
    return `<tr><td><span class="tag ${b.type==='recette'?'tg':'tr'}">${b.type==='recette'?'Recette':'Charge'}</span></td><td>${esc(b.lib||'—')}</td><td>${esc(b.cat||'Autre')}</td><td>${(+b.mt||0).toLocaleString('fr-FR')} €</td><td>${real.toLocaleString('fr-FR')} €</td><td class="${ecart>=0?'apos':'aneg'}">${ecart.toLocaleString('fr-FR')} €</td><td><button class="ico-btn write-only" onclick="openBudgetModal('${String(b.id)}')">✏️</button></td></tr>`;
  }).join(''):'<tr><td colspan="7" style="color:var(--text2);text-align:center;padding:18px">Aucun budget prévisionnel pour cette année. Ajoute une première ligne.</td></tr>';
}
function openBudgetModal(id){
  if(!canWrite()){ denyWrite(); return; }
  const b=id!=null?(window.CACHE?.budgets||[]).find(x=>String(x.id)===String(id)):null;
  $('mbudget-t').innerHTML=b?'📅 Modifier ligne budget':'📅 Nouvelle ligne budget';
  $('budget-del').style.display=b?'block':'none';
  sv('budget-id',b?.id||'');
  sv('budget-year-inp',b?.year||selectedBudgetYear()||new Date().getFullYear());
  sv('budget-type',b?.type||'charge');
  sv('budget-lib',b?.lib||'');
  sv('budget-cat',b?.cat||'Autre');
  sv('budget-mt',b?.mt||'');
  sv('budget-notes',b?.notes||'');
  openModal('m-budget');
}
async function saveBudgetLine(){
  if(!canWrite()){ denyWrite(); return; }
  const id=v('budget-id'), e=!!id;
  const obj={id:e?id:Date.now(),year:+v('budget-year-inp')||new Date().getFullYear(),type:v('budget-type'),lib:v('budget-lib'),cat:v('budget-cat'),mt:+v('budget-mt')||0,notes:v('budget-notes')};
  const ok=await saveWithFeedback(window.dbSet?.('budgets',obj), e?'Budget mis à jour ✓':'Ligne budget ajoutée ✓');
  if(ok) closeModal('m-budget');
}
async function deleteBudgetLine(){
  const id=v('budget-id'); if(!id) return;
  if(!confirm('Supprimer cette ligne de budget ?')) return;
  const ok=await deleteWithFeedback('budgets',id,'Ligne budget supprimée ✓');
  if(ok) closeModal('m-budget');
}


function pctLabel(real, planned){
  if(!planned) return real ? 'hors budget' : '0%';
  return Math.round((real/planned)*100)+'%';
}
function setBar(id, pct){
  const el=$(id); if(!el) return;
  el.style.width=Math.max(0,Math.min(100,pct||0))+'%';
}
function renderFinancialDashboard(){
  const year=selectedBudgetYear();
  const ops=(window.CACHE?.ops||[]).filter(o=>o.date && new Date(o.date).getFullYear()===+year);
  const budgets=(window.CACHE?.budgets||[]).filter(b=>+b.year===+year);
  const realRec=ops.filter(o=>(+o.mt||0)>0).reduce((s,o)=>s+(+o.mt||0),0);
  const realChg=ops.filter(o=>(+o.mt||0)<0).reduce((s,o)=>s+Math.abs(+o.mt||0),0);
  const plannedRec=budgets.filter(b=>b.type==='recette').reduce((s,b)=>s+(+b.mt||0),0);
  const plannedChg=budgets.filter(b=>b.type==='charge').reduce((s,b)=>s+(+b.mt||0),0);
  const realNet=realRec-realChg, plannedNet=plannedRec-plannedChg, gap=realNet-plannedNet;
  const missing=ops.filter(o=>!o.docId);
  const docRate=ops.length ? Math.round(((ops.length-missing.length)/ops.length)*100) : 0;
  const money=n=>(+n||0).toLocaleString('fr-FR')+' €';
  const set=(id,val)=>{const el=$(id);if(el)el.textContent=val;};
  set('fd-real-net',money(realNet));
  set('fd-budget-net',money(plannedNet));
  set('fd-gap',(gap>=0?'+':'')+money(gap));
  set('fd-gap-help',gap>=0?'Au-dessus du prévisionnel':'Sous le prévisionnel');
  const gapEl=$('fd-gap'); if(gapEl) gapEl.style.color=gap>=0?'var(--green)':'var(--red)';
  set('fd-doc-rate',docRate+'%');
  set('fd-doc-help',missing.length+' opération(s) sans justificatif');
  set('fd-bar-rec-label',money(realRec)+' / '+money(plannedRec));
  set('fd-bar-chg-label',money(realChg)+' / '+money(plannedChg));
  set('fd-consumed-label',pctLabel(realChg, plannedChg));
  setBar('fd-bar-rec', plannedRec?realRec/plannedRec*100:(realRec?100:0));
  setBar('fd-bar-chg', plannedChg?realChg/plannedChg*100:(realChg?100:0));
  setBar('fd-bar-consumed', plannedChg?realChg/plannedChg*100:0);
  const alerts=[];
  if(!budgets.length) alerts.push(['Budget prévisionnel','À créer']);
  if(missing.length) alerts.push(['Justificatifs manquants',missing.length]);
  if(plannedChg && realChg>plannedChg) alerts.push(['Charges au-dessus budget','+'+money(realChg-plannedChg)]);
  if(plannedRec && realRec<plannedRec) alerts.push(['Recettes sous budget','-'+money(plannedRec-realRec)]);
  if(!alerts.length) alerts.push(['Situation comptable','OK']);
  const box=$('fd-alerts');
  if(box) box.innerHTML=alerts.map(a=>`<div class="finance-list-row"><span>${esc(a[0])}</span><strong>${esc(a[1])}</strong></div>`).join('');
}

function bankBalanceRef(){
  return (window.CACHE?.settings||[]).find(x=>String(x.id)==='bankBalance') || null;
}
function estimatedBankBalance(){
  const ref=bankBalanceRef();
  if(!ref || ref.balance==null || !ref.date) return null;
  const refDate=String(ref.date);
  const delta=(window.CACHE?.ops||[]).filter(o=>String(o.date||'')>refDate).reduce((s,o)=>s+(+o.mt||0),0);
  return {balance:(+ref.balance||0)+delta, ref, delta};
}
function currentJournalFilters(){
  return {
    q: normalizeText($('journal-search')?.value||''),
    type: $('journal-filter-type')?.value || 'all',
    source: $('journal-filter-source')?.value || 'all',
    status: $('journal-filter-status')?.value || 'all'
  };
}
function opMatchesJournalFilters(op, f){
  const mt=+op.mt||0;
  if(f.type==='recette' && mt<=0) return false;
  if(f.type==='charge' && mt>=0) return false;
  const isCA=String(op.sourceBank||op.source||'').toLowerCase().includes('credit_agricole') || String(op.sourceLabel||'').toLowerCase().includes('crédit agricole') || !!op.bankImportId;
  if(f.source==='ca' && !isCA) return false;
  if(f.source==='manual' && isCA) return false;
  if(f.status==='missing_doc' && (op.docId || op.noDocRequired || op.justificatifNotRequired)) return false;
  if(f.status==='a_verifier' && op.status!=='a_verifier') return false;
  if(f.status==='classified' && (!op.cat || op.cat==='À classer')) return false;
  if(f.q){
    const hay=normalizeText([op.date, fmtDate(op.date), op.lib, op.bien, op.cat, op.payment, op.status, op.sourceLabel, mt, Math.abs(mt).toLocaleString('fr-FR')].join(' '));
    if(!hay.includes(f.q)) return false;
  }
  return true;
}
function renderCompta(){
  const ct=document.querySelector('#page-compta .sec-hdr h2'); const cp=document.querySelector('#page-compta .sec-hdr p');
  if(ct) ct.textContent=isGFAContext()?'Fermages et comptabilité GFA':'Comptabilité';
  if(cp) cp.textContent=isGFAContext()?'Suivi des fermages, recettes agricoles, charges foncières, taxes et justificatifs.':'Pilotage financier, journal comptable, budget prévisionnel et préparation comptable.';
  const ops=window.CACHE?.ops||[];
  const rec=ops.filter(o=>(+o.mt||0)>0).reduce((s,o)=>s+(+o.mt||0),0);
  const chg=ops.filter(o=>(+o.mt||0)<0).reduce((s,o)=>s+Math.abs(+o.mt||0),0);
  const set=(id,v)=>{const el=$(id);if(el)el.textContent=v;};
  set('c-rec',rec.toLocaleString('fr-FR')+' €');
  set('c-chg',chg.toLocaleString('fr-FR')+' €');
  set('c-net',(rec-chg).toLocaleString('fr-FR')+' €');
  const bank=estimatedBankBalance();
  if(bank){
    set('c-bank-balance', bank.balance.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' €');
    set('c-bank-balance-label','Solde estimé depuis le '+fmtDate(bank.ref.date));
  }else{
    set('c-bank-balance','—');
    set('c-bank-balance-label','Solde bancaire à renseigner');
  }
  renderBudget();
  renderFinancialDashboard();
  const tb=$('c-table');if(!tb)return;
  const filters=currentJournalFilters();
  const filtered=ops.filter(op=>opMatchesJournalFilters(op, filters)).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  const jc=$('journal-count'); if(jc) jc.textContent=filtered.length===ops.length ? ops.length+' opération'+(ops.length>1?'s':'') : filtered.length+' / '+ops.length+' opération(s)';
  tb.innerHTML=filtered.length?filtered.map(op=>{
    const mt=+op.mt||0;
    const isCA=String(op.sourceBank||op.source||'').toLowerCase().includes('credit_agricole') || !!op.bankImportId;
    const verify=op.status==='a_verifier' || op.cat==='À classer';
    return `<tr><td>${fmtDate(op.date)}</td><td>${esc(op.lib||'—')}${isCA?'<span class="bank-badge">CA</span>':''}${verify?'<span class="verify-badge">à vérifier</span>':''}</td>
    <td style="color:var(--text2);font-size:12px">${esc(op.bien||'—')}</td>
    <td><span class="tag ${mt>0?'tg':'tr'}">${esc(op.cat||'Autre')}</span></td>
    <td>${op.docId?`<button class="btn-out btn-sm" onclick="event.stopPropagation();openStoredDoc(${op.docId})">Voir</button>`:(op.noDocRequired||op.justificatifNotRequired?`<button class="doc-status-btn doc-no-required" title="Cliquer pour remettre en justificatif manquant" onclick="event.stopPropagation();toggleNoDocRequired('${String(op.id)}')">OK · bancaire</button>`:`<button class="doc-status-btn doc-missing" title="Cliquer si aucun justificatif n'est nécessaire" onclick="event.stopPropagation();toggleNoDocRequired('${String(op.id)}')">Manquant</button>`)}</td>
    <td class="${mt>0?'apos':'aneg'}">${mt>0?'+':'-'}${Math.abs(mt).toLocaleString('fr-FR')} €</td>
    <td><div class="td-act">
      <button class="ico-btn write-only" onclick="openOpModal('${String(op.id)}')">✏️</button>
      <button class="ico-btn write-only" onclick="confirmDel('op-direct','${String(op.id)}')">🗑</button>
    </div></td></tr>`;
  }).join(''):'<tr><td colspan="7" style="color:var(--text2);text-align:center;padding:18px">Aucune opération ne correspond à la recherche ou aux filtres.</td></tr>';
  try{ renderComptable(); }catch(e){ console.warn('Préparation comptable non rendue', e); }
}

function ensureNoDocModal(){
  let wrap=document.getElementById('no-doc-modal-overlay');
  if(wrap) return wrap;
  wrap=document.createElement('div');
  wrap.id='no-doc-modal-overlay';
  wrap.className='no-doc-modal-overlay';
  wrap.innerHTML=`<div class="no-doc-modal" role="dialog" aria-modal="true" aria-labelledby="no-doc-title">
    <div class="no-doc-modal-head">
      <div class="no-doc-modal-icon">✓</div>
      <div><h3 id="no-doc-title" class="no-doc-modal-title">Justificatif non nécessaire</h3><p class="no-doc-modal-sub">Marquer manuellement cette opération comme validée sans pièce jointe.</p></div>
    </div>
    <div class="no-doc-modal-body">
      <div class="no-doc-op-preview"><strong id="no-doc-op-lib">—</strong><span id="no-doc-op-meta">—</span></div>
      <div id="no-doc-choices" class="no-doc-choice-grid"></div>
      <textarea id="no-doc-reason" placeholder="Motif interne, exemple : opération bancaire, loyer reçu, frais bancaires..."></textarea>
    </div>
    <div class="no-doc-modal-foot">
      <button type="button" class="btn-out" id="no-doc-cancel">Annuler</button>
      <button type="button" class="btn" id="no-doc-save">Valider</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  return wrap;
}

function openNoDocRequiredModal(op){
  return new Promise(resolve=>{
    const wrap=ensureNoDocModal();
    const lib=document.getElementById('no-doc-op-lib');
    const meta=document.getElementById('no-doc-op-meta');
    const reason=document.getElementById('no-doc-reason');
    const choices=document.getElementById('no-doc-choices');
    const cancel=document.getElementById('no-doc-cancel');
    const save=document.getElementById('no-doc-save');
    const mt=Number(op.mt||0);
    lib.textContent=op.lib||'Opération sans libellé';
    meta.textContent=`${fmtDate(op.date)} · ${mt>=0?'+':'-'}${Math.abs(mt).toLocaleString('fr-FR')} € · ${op.cat||'À classer'}`;
    const presets=['Opération bancaire sans justificatif nécessaire','Virement de loyer reçu','Frais / facturation bancaire','Écriture interne ou régularisation'];
    choices.innerHTML=presets.map((p,i)=>`<button type="button" class="no-doc-choice${i===0?' active':''}" data-reason="${esc(p)}">${esc(p)}</button>`).join('');
    reason.value=op.noDocReason || presets[0];
    function close(val){
      wrap.classList.remove('open');
      document.removeEventListener('keydown',onKey);
      resolve(val);
    }
    function onKey(e){ if(e.key==='Escape') close(null); }
    choices.querySelectorAll('.no-doc-choice').forEach(btn=>btn.onclick=()=>{
      choices.querySelectorAll('.no-doc-choice').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      reason.value=btn.dataset.reason||'';
      reason.focus();
    });
    cancel.onclick=()=>close(null);
    save.onclick=()=>close((reason.value||presets[0]).trim());
    wrap.onclick=e=>{ if(e.target===wrap) close(null); };
    document.addEventListener('keydown',onKey);
    wrap.classList.add('open');
    setTimeout(()=>reason.focus(),60);
  });
}

function openNoDocResetModal(op){
  return new Promise(resolve=>{
    const wrap=ensureNoDocModal();
    document.getElementById('no-doc-title').textContent='Remettre le justificatif en manquant ?';
    document.querySelector('.no-doc-modal-sub').textContent='Cette opération ressortira dans les justificatifs à traiter.';
    document.querySelector('.no-doc-modal-icon').textContent='↺';
    document.getElementById('no-doc-op-lib').textContent=op.lib||'Opération sans libellé';
    document.getElementById('no-doc-op-meta').textContent=`${fmtDate(op.date)} · ${op.noDocReason||'Validée sans justificatif'}`;
    document.getElementById('no-doc-choices').innerHTML='';
    const textarea=document.getElementById('no-doc-reason');
    textarea.value=''; textarea.style.display='none';
    const cancel=document.getElementById('no-doc-cancel');
    const save=document.getElementById('no-doc-save');
    save.textContent='Remettre en manquant'; save.classList.add('no-doc-danger');
    function restore(){
      document.getElementById('no-doc-title').textContent='Justificatif non nécessaire';
      document.querySelector('.no-doc-modal-sub').textContent='Marquer manuellement cette opération comme validée sans pièce jointe.';
      document.querySelector('.no-doc-modal-icon').textContent='✓';
      textarea.style.display='block'; save.textContent='Valider'; save.classList.remove('no-doc-danger');
    }
    function close(val){ wrap.classList.remove('open'); document.removeEventListener('keydown',onKey); restore(); resolve(val); }
    function onKey(e){ if(e.key==='Escape') close(false); }
    cancel.onclick=()=>close(false);
    save.onclick=()=>close(true);
    wrap.onclick=e=>{ if(e.target===wrap) close(false); };
    document.addEventListener('keydown',onKey);
    wrap.classList.add('open');
  });
}

async function toggleNoDocRequired(id){
  const op=(window.CACHE?.ops||[]).find(x=>String(x.id)===String(id));
  if(!op){ toast('Opération introuvable'); return; }
  const already=!!(op.noDocRequired||op.justificatifNotRequired);
  if(already){
    const ok=await openNoDocResetModal(op);
    if(!ok) return;
    const updated={...op,noDocRequired:false,justificatifNotRequired:false,noDocReason:''};
    await saveWithFeedback(window.dbSet?.('ops',updated),'Justificatif de nouveau demandé ✓');
  }else{
    const reason=await openNoDocRequiredModal(op);
    if(reason===null) return;
    const updated={...op,noDocRequired:true,justificatifNotRequired:true,noDocReason:String(reason||'Opération bancaire sans justificatif nécessaire'),docId:''};
    await saveWithFeedback(window.dbSet?.('ops',updated),'Opération marquée OK sans justificatif ✓');
  }
  try{ renderCompta(); }catch(e){}
  try{ renderHome(); }catch(e){}
}

function normalizeText(str){
  return String(str??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
}
function classifyBankOperation(lib, mt){
  const l=normalizeText(lib);
  if(/loyer|ferm(age|ages)|virement.*loyer/.test(l)) return mt>=0?'Loyer':'À classer';
  if(/rem\s*chq|cheque|chèque/.test(l)) return mt>=0?'Recette autre':'Banque';
  if(/taxe|impot|impôt|tresor|trésor|fonciere|foncière/.test(l)) return 'Taxe foncière';
  if(/assurance|maif|axa|allianz|macif|groupama/.test(l)) return 'Assurance';
  if(/edf|engie|eau|veolia|suez|energie|énergie|electricite|électricité/.test(l)) return 'Charges locatives';
  if(/comptable|honoraire|notaire|frais/.test(l)) return 'Honoraires';
  if(/leroy|brico|travaux|artisan|plomb|toiture|chauffage/.test(l)) return 'Travaux';
  if(/cotisation|frais bancaire|commission|carte|tenue de compte/.test(l)) return 'Banque';
  return 'À classer';
}
function bankImportKey(date, lib, mt){
  return 'ca-'+String(date||'')+'-'+normalizeText(lib).replace(/[^a-z0-9]+/g,'-').slice(0,80)+'-'+Number(mt||0).toFixed(2);
}
function existingBankKeys(){
  const set=new Set();
  (window.CACHE?.ops||[]).forEach(o=>{
    if(o.bankImportId) set.add(String(o.bankImportId));
    set.add(bankImportKey(o.date,o.lib,+o.mt||0));
  });
  return set;
}
function parseBankDate(value, fallbackYear){
  if(value instanceof Date && !isNaN(value)) return value.toISOString().split('T')[0];
  if(typeof value==='number' && window.XLSX){
    try{ const d=XLSX.SSF.parse_date_code(value); if(d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`; }catch(e){}
  }
  let s=String(value||'').trim();
  if(!s) return '';
  s=s.replace(/\s+/g,'');
  let m=s.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
  if(m){ let y=+m[3]; if(y<100) y+=2000; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  m=s.match(/^(\d{1,2})[\/\.-](\d{1,2})$/);
  if(m){ const y=fallbackYear||new Date().getFullYear(); return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  const d=new Date(s); if(!isNaN(d)) return d.toISOString().split('T')[0];
  return '';
}
function readArrayBufferFile(file){ return new Promise((res,rej)=>{const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsArrayBuffer(file);}); }
function findHeaderIndex(rows){
  return rows.findIndex(row=>{
    const h=row.map(normalizeText).join(' | ');
    return h.includes('date') && h.includes('libelle') && (h.includes('debit') || h.includes('credit'));
  });
}
function headerMap(headers){
  const map={};
  headers.forEach((h,i)=>{
    const n=normalizeText(h);
    if(n.includes('date ope') || n==='date' || n.includes('operation')) map.date=i;
    if(n.includes('date valeur')) map.dateValeur=i;
    if(n.includes('libelle')) map.lib=i;
    if(n.includes('debit')) map.debit=i;
    if(n.includes('credit')) map.credit=i;
    if(n.includes('solde')) map.solde=i;
  });
  return map;
}
function buildOpsFromCreditAgricoleRows(rows, year){
  const idx=findHeaderIndex(rows);
  if(idx<0) throw new Error('Colonnes Crédit Agricole non reconnues. Attendu : Date, Libellé, Débit, Crédit, Solde.');
  const headers=rows[idx];
  const map=headerMap(headers);
  const out=[];
  for(const row of rows.slice(idx+1)){
    const rawLib=String(row[map.lib]??'').trim();
    if(!rawLib) continue;
    const libNorm=normalizeText(rawLib);
    if(/ancien solde|nouveau solde|total des operations|iban|bic/.test(libNorm)) continue;
    const date=parseBankDate(row[map.date], year);
    if(!date) continue;
    const debit=numFR(row[map.debit]);
    const credit=numFR(row[map.credit]);
    if(!debit && !credit) continue;
    const mt=credit ? Math.abs(credit) : -Math.abs(debit);
    const cat=classifyBankOperation(rawLib, mt);
    out.push({date,lib:rawLib,mt,type:mt<0?'charge':'recette',cat,solde:map.solde!=null?numFR(row[map.solde]):null});
  }
  return out;
}
async function importCreditAgricoleFile(event){
  const file=event.target.files?.[0]; event.target.value='';
  if(!file) return; if(!canWrite()){ denyWrite(); return; }
  try{
    let rows=[];
    if(/\.csv$/i.test(file.name)){
      const parsed=parseCSVText(await readTextFile(file));
      const headers=Object.keys(parsed[0]||{});
      rows=[headers,...parsed.map(o=>headers.map(h=>o[h]))];
    }else{
      if(!window.XLSX) throw new Error('Bibliothèque XLSX non chargée. Vérifie ta connexion internet puis recharge la page.');
      const wb=XLSX.read(await readArrayBufferFile(file),{type:'array',cellDates:true});
      const ws=wb.Sheets[wb.SheetNames[0]];
      rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
    }
    const ops=buildOpsFromCreditAgricoleRows(rows, new Date().getFullYear());
    if(!ops.length){ toast('Aucune opération Crédit Agricole détectée'); return; }
    const keys=existingBankKeys();
    const newOps=ops.filter(o=>!keys.has(bankImportKey(o.date,o.lib,o.mt)));
    const ignored=ops.length-newOps.length;
    if(!newOps.length){ toast('Aucune nouvelle opération : doublons ignorés'); return; }
    if(!confirm(`Importer ${newOps.length} opération(s) Crédit Agricole ?${ignored?`\n${ignored} doublon(s) ignoré(s).`:''}`)) return;
    let count=0;
    for(const o of newOps){
      await window.dbSet?.('ops',{id:Date.now()+count,date:o.date,lib:o.lib,bien:'',cat:o.cat,type:o.type,payment:'Crédit Agricole',status:o.cat==='À classer'?'a_verifier':'paye',docId:'',mt:o.mt,sourceBank:'credit_agricole',sourceLabel:'Import Crédit Agricole XLS/XLSX',bankImportId:bankImportKey(o.date,o.lib,o.mt),bankBalanceAfter:o.solde});
      count++;
    }
    toast(count+' opération(s) Crédit Agricole importée(s) ✓');
  }catch(err){ console.error(err); toast('Erreur import Crédit Agricole : '+(err.message||err)); }
}
function openBankBalanceModal(){
  if(!canWrite()){ denyWrite(); return; }
  const ref=bankBalanceRef();
  sv('bank-balance-date', ref?.date || new Date().toISOString().split('T')[0]);
  sv('bank-balance-amount', ref?.balance ?? '');
  sv('bank-balance-label-input', ref?.label || 'Compte courant Crédit Agricole');
  openModal('m-bank-balance');
}
async function saveBankBalanceRef(){
  if(!canWrite()){ denyWrite(); return; }
  const date=v('bank-balance-date'), balance=+v('bank-balance-amount');
  if(!date || isNaN(balance)){ toast('Renseigne une date et un solde valide.'); return; }
  const obj={id:'bankBalance',date,balance,label:v('bank-balance-label-input')||'Compte courant Crédit Agricole',updatedAt:new Date().toISOString()};
  const ok=await saveWithFeedback(window.dbSet?.('settings',obj),'Solde bancaire enregistré ✓');
  if(ok){ closeModal('m-bank-balance'); renderCompta(); }
}

// ══ IMPORT PDF CRÉDIT AGRICOLE V2.1 INTÉGRÉ ══
let CA_PDF_PREVIEW_ROWS = [];

function caPdfToNum(s){
  if(s==null) return 0;
  let x=String(s).trim().replace(/\u00a0/g,' ').replace(/€/g,'').replace(/\s+/g,'');
  if(!x) return 0;
  const neg=/^-/.test(x);
  x=x.replace(/[^0-9,.-]/g,'');
  if((x.match(/,/g)||[]).length>1) x=x.replace(/,(?=.*,)/g,'');
  x=x.replace(/\.(?=\d{3}(\D|$))/g,'').replace(',', '.');
  const n=parseFloat(x);
  return isNaN(n)?0:(neg?-Math.abs(n):n);
}
function caPdfFmt(n){ return (+n||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function caPdfPad2(x){ return String(x).padStart(2,'0'); }
function caPdfNormDate(d, year){
  if(!d) return '';
  d=String(d).trim().replace(/-/g,'/').replace(/\./g,'/');
  const m=d.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if(!m) return d;
  let y=m[3] || year || new Date().getFullYear();
  if(String(y).length===2) y='20'+y;
  return `${y}-${caPdfPad2(m[2])}-${caPdfPad2(m[1])}`;
}
function caPdfExtractYear(text){
  const m=String(text||'').match(/(?:31|30|29|28)\s+(?:Janvier|Février|Fevrier|Mars|Avril|Mai|Juin|Juillet|Août|Aout|Septembre|Octobre|Novembre|Décembre|Decembre)\s+(20\d{2})/i) || String(text||'').match(/\b(20\d{2})\b/);
  return m?m[1]:String(v('ca-pdf-year')||new Date().getFullYear());
}
function caPdfClassify(lib, debit, credit){
  const s=String(lib||'').toUpperCase();
  if(s.includes('LOYER')) return 'Loyer';
  if(s.includes('REM CHQ')||s.includes('REMISE CH')) return credit>0?'Recette chèque':'Chèque';
  if(s.includes('PRLV')||s.includes('PRELEV')||s.includes('FACTURE CREDIT AGRICOLE')) return 'Frais bancaires';
  if(s.includes('ASSURANCE')) return 'Assurance';
  if(s.includes('TAXE')||s.includes('IMPOT')) return 'Fiscalité';
  if(s.includes('EDF')||s.includes('ENGIE')||s.includes('EAU')) return 'Charges';
  if(s.includes('VIREMENT') && credit>0) return 'Recette';
  if(debit>0) return 'À classer charge';
  if(credit>0) return 'À classer recette';
  return 'À classer';
}
function caPdfCleanLib(s){
  return String(s||'').replace(/\s+/g,' ').replace(/Total des opérations.*/i,'').replace(/Nouveau solde.*/i,'').trim();
}
function caPdfMoneyTokens(line){
  // Montants stricts avec virgule décimale : exclut les numéros de chèque sans virgule.
  const re=/(^|\s)(-?\d{1,3}(?:[\s\u00a0]\d{3})*,\d{2}|-?\d+,\d{2})(?=\s|$)/g;
  const found=[]; let m;
  while((m=re.exec(line))){ found.push({text:m[2], index:m.index + m[1].length, value:caPdfToNum(m[2])}); }
  return found;
}
function caPdfInferDebitCredit(line, amounts){
  if(!amounts.length) return {debit:0, credit:0};
  const last=amounts[amounts.length-1];
  if(amounts.length>=2){
    return {debit:amounts[amounts.length-2].value, credit:last.value};
  }
  const up=String(line||'').toUpperCase();
  if(/\b(PRLV|PRELEV|PRÉLÈV|FACTURE|VIR INST VERS|VIREMENT\s+VIR\s+INST\s+VERS|CARTE|COTISATION|FRAIS)\b/.test(up)) return {debit:last.value, credit:0};
  if(/\b(REM\s*CHQ|REMISE|LOYER|VIREMENT)\b/.test(up)) return {debit:0, credit:last.value};
  return last.index > Math.max(line.length,90)*0.70 ? {debit:0, credit:last.value} : {debit:last.value, credit:0};
}
function parseCreditAgricolePdfRowsV21(text){
  const year=caPdfExtractYear(text);
  let lines=String(text||'').split(/\r?\n/).map(l=>l.replace(/\t/g,' ').replace(/\s+/g,' ').trim()).filter(Boolean);
  const out=[];
  for(let i=0;i<lines.length;i++){
    let line=lines[i];
    if(/IBAN|BIC|Ancien solde|Nouveau solde|Total des op|Date op|Date valeur|Libellé|Débit|Crédit|RELEVE DE COMPTES|Votre agence|Vos contacts|SYNTH[EÈ]SE|Compte Courant/i.test(line)) continue;
    const m=line.match(/^(\d{1,2}[\.\/](?:\d{1,2}))(?:\s+)(\d{1,2}[\.\/](?:\d{1,2}))(?:\s+)(.+)$/);
    if(!m) continue;
    let dateOpe=m[1], dateVal=m[2], rest=m[3];
    let j=i+1;
    while(j<lines.length && !/^(\d{1,2}[\.\/]\d{1,2})\s+(\d{1,2}[\.\/]\d{1,2})\s+/.test(lines[j]) && !/Total des op|Nouveau solde|Ancien solde/i.test(lines[j])){
      if(!/^(Date|Débit|Crédit|IBAN|BIC)/i.test(lines[j])) rest += ' ' + lines[j];
      j++;
    }
    i=j-1;
    const amounts=caPdfMoneyTokens(rest);
    if(!amounts.length) continue;
    const dc=caPdfInferDebitCredit(rest, amounts);
    let lib=rest;
    // Ne retire QUE le ou les montants de fin de ligne. Les références type Rem Chq 4217556 restent dans le libellé.
    const removeCount=(dc.debit>0 && dc.credit>0) ? 2 : 1;
    const amtTexts=amounts.slice(-removeCount).map(a=>a.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    amtTexts.forEach(t=>{ lib=lib.replace(new RegExp('\\s*'+t+'\\s*$'), ''); });
    lib=caPdfCleanLib(lib) || 'Opération Crédit Agricole';
    const debit=dc.debit||0, credit=dc.credit||0;
    out.push({dateOpe:caPdfNormDate(dateOpe,year),dateValeur:caPdfNormDate(dateVal,year),libelle:lib,debit:debit?caPdfFmt(debit):'',credit:credit?caPdfFmt(credit):'',categorie:caPdfClassify(lib,debit,credit),source:'CA PDF'});
  }
  const seen=new Set();
  return out.filter(r=>{
    const k=[r.dateOpe,r.dateValeur,r.libelle,r.debit,r.credit].join('|');
    if(seen.has(k)) return false;
    seen.add(k); return true;
  });
}

async function extractTextFromCreditAgricolePdf(file){
  if(!window.pdfjsLib) throw new Error('Bibliothèque PDF non chargée. Recharge la page puis réessaie.');
  try{ pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; }catch(e){}
  const buffer=await readArrayBufferFile(file);
  const pdf=await pdfjsLib.getDocument({data:buffer}).promise;
  const allLines=[];
  for(let pageNum=1; pageNum<=pdf.numPages; pageNum++){
    const page=await pdf.getPage(pageNum);
    const content=await page.getTextContent();
    const items=(content.items||[]).map(it=>({text:String(it.str||'').trim(),x:it.transform?.[4]||0,y:it.transform?.[5]||0})).filter(it=>it.text);
    const groups=[];
    items.forEach(it=>{
      let g=groups.find(row=>Math.abs(row.y-it.y)<3);
      if(!g){ g={y:it.y,items:[]}; groups.push(g); }
      g.items.push(it);
    });
    groups.sort((a,b)=>b.y-a.y);
    groups.forEach(g=>{
      g.items.sort((a,b)=>a.x-b.x);
      let line=''; let lastX=null;
      g.items.forEach(it=>{
        if(lastX!==null && it.x-lastX>26) line+=' ';
        else if(line) line+=' ';
        line+=it.text;
        lastX=it.x + it.text.length*4;
      });
      line=line.replace(/\s+/g,' ').trim();
      if(line) allLines.push(line);
    });
  }
  return allLines.join('\n');
}

function renderCreditAgricolePdfPreview(){
  const tb=$('ca-pdf-preview-table'); if(!tb) return;
  if(!CA_PDF_PREVIEW_ROWS.length){
    tb.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--text2)">Aucune opération détectée.</td></tr>';
    const help=$('ca-pdf-preview-help'); if(help) help.textContent='Aucune ligne à importer.';
    return;
  }
  tb.innerHTML=CA_PDF_PREVIEW_ROWS.map((r,i)=>`<tr>
    <td><input value="${esc(r.dateOpe||'')}" onchange="updateCreditAgricolePdfRow(${i},'dateOpe',this.value)" style="width:120px;background:var(--inp);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px"></td>
    <td><input value="${esc(r.dateValeur||'')}" onchange="updateCreditAgricolePdfRow(${i},'dateValeur',this.value)" style="width:120px;background:var(--inp);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px"></td>
    <td><input value="${esc(r.libelle||'')}" onchange="updateCreditAgricolePdfRow(${i},'libelle',this.value)" style="min-width:240px;width:100%;background:var(--inp);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px"></td>
    <td><input value="${esc(r.debit||'')}" onchange="updateCreditAgricolePdfRow(${i},'debit',this.value)" style="width:95px;background:var(--inp);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px"></td>
    <td><input value="${esc(r.credit||'')}" onchange="updateCreditAgricolePdfRow(${i},'credit',this.value)" style="width:95px;background:var(--inp);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px"></td>
    <td><input value="${esc(r.categorie||'')}" onchange="updateCreditAgricolePdfRow(${i},'categorie',this.value)" style="width:135px;background:var(--inp);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px"></td>
    <td><button class="ico-btn" onclick="deleteCreditAgricolePdfRow(${i})">🗑</button></td>
  </tr>`).join('');
  const help=$('ca-pdf-preview-help'); if(help) help.textContent=`${CA_PDF_PREVIEW_ROWS.length} opération(s) détectée(s). Vérifie puis importe dans le journal.`;
}
function updateCreditAgricolePdfRow(i,key,val){
  if(!CA_PDF_PREVIEW_ROWS[i]) return;
  CA_PDF_PREVIEW_ROWS[i][key]=val;
  if(['debit','credit','libelle'].includes(key)){
    const d=caPdfToNum(CA_PDF_PREVIEW_ROWS[i].debit), c=caPdfToNum(CA_PDF_PREVIEW_ROWS[i].credit);
    CA_PDF_PREVIEW_ROWS[i].categorie=caPdfClassify(CA_PDF_PREVIEW_ROWS[i].libelle,d,c);
  }
  renderCreditAgricolePdfPreview();
}
function deleteCreditAgricolePdfRow(i){ CA_PDF_PREVIEW_ROWS.splice(i,1); renderCreditAgricolePdfPreview(); }
function addCreditAgricolePdfPreviewRow(){
  CA_PDF_PREVIEW_ROWS.push({dateOpe:'',dateValeur:'',libelle:'',debit:'',credit:'',categorie:'À classer',source:'Manuel'});
  renderCreditAgricolePdfPreview();
}
function parseCreditAgricolePdfPreview(){
  CA_PDF_PREVIEW_ROWS=parseCreditAgricolePdfRowsV21(v('ca-pdf-text'));
  renderCreditAgricolePdfPreview();
  toast(CA_PDF_PREVIEW_ROWS.length ? CA_PDF_PREVIEW_ROWS.length+' opération(s) détectée(s)' : 'Aucune opération détectée');
}

async function importCreditAgricolePdfFile(event){
  const file=event.target.files?.[0];
  event.target.value='';
  if(!file) return;
  if(!canWrite()){ denyWrite(); return; }
  const status=$('ca-pdf-status');
  try{
    if(status) status.textContent='Lecture du PDF en cours...';
    const text=await extractTextFromCreditAgricolePdf(file);
    sv('ca-pdf-text', text);
    CA_PDF_PREVIEW_ROWS=parseCreditAgricolePdfRowsV21(text);
    renderCreditAgricolePdfPreview();
    if(status) status.textContent=CA_PDF_PREVIEW_ROWS.length ? `PDF lu : ${CA_PDF_PREVIEW_ROWS.length} opération(s) détectée(s).` : 'PDF lu, mais aucune opération détectée. Vérifie le texte brut extrait.';
  }catch(err){
    console.error(err);
    if(status) status.textContent='Erreur lecture PDF : '+(err.message||err);
    toast('Erreur lecture PDF : '+(err.message||err));
  }
}

function openCreditAgricolePdfModal(){
  if(!canWrite()){ denyWrite(); return; }
  sv('ca-pdf-year', new Date().getFullYear());
  sv('ca-pdf-account', 'Compte courant Crédit Agricole');
  sv('ca-pdf-text','');
  CA_PDF_PREVIEW_ROWS=[];
  const st=$('ca-pdf-status'); if(st) st.textContent='Aucun PDF sélectionné.';
  renderCreditAgricolePdfPreview();
  openModal('m-ca-pdf-import');
  setTimeout(()=>{
    const dz=$('ca-pdf-drop-zone');
    if(!dz || dz.dataset.bound==='1') return;
    dz.dataset.bound='1';
    dz.addEventListener('dragover',e=>{e.preventDefault(); dz.style.borderColor='var(--gold)';});
    dz.addEventListener('dragleave',()=>{dz.style.borderColor='var(--border)';});
    dz.addEventListener('drop',e=>{e.preventDefault(); dz.style.borderColor='var(--border)'; const f=e.dataTransfer.files?.[0]; if(f) importCreditAgricolePdfFile({target:{files:[f],value:''}});});
  },0);
}

async function importCreditAgricolePdfPreviewRows(){
  if(!canWrite()){ denyWrite(); return; }
  try{
    const rows=CA_PDF_PREVIEW_ROWS||[];
    if(!rows.length){ toast('Aucune opération à importer.'); return; }
    const ops=rows.map(r=>{
      const debit=caPdfToNum(r.debit), credit=caPdfToNum(r.credit), mt=credit-debit;
      return {date:r.dateOpe||r.dateValeur,lib:r.libelle||'Opération Crédit Agricole',mt,type:mt<0?'charge':'recette',cat:r.categorie||caPdfClassify(r.libelle,debit,credit)};
    }).filter(o=>o.date && o.lib && o.mt!==0);
    if(!ops.length){ toast('Aucune opération valide à importer.'); return; }
    const keys=existingBankKeys();
    const newOps=ops.filter(o=>!keys.has(bankImportKey(o.date,o.lib,o.mt)));
    const ignored=ops.length-newOps.length;
    if(!newOps.length){ toast('Aucune nouvelle opération : doublons ignorés'); return; }
    if(!confirm(`Importer ${newOps.length} opération(s) depuis le relevé PDF ?${ignored?`\n${ignored} doublon(s) ignoré(s).`:''}`)) return;
    let count=0;
    for(const o of newOps){
      await window.dbSet?.('ops',{id:Date.now()+count,date:o.date,lib:o.lib,bien:'',cat:o.cat,type:o.type,payment:'Crédit Agricole',status:String(o.cat||'').includes('À classer')?'a_verifier':'paye',docId:'',mt:o.mt,sourceBank:'credit_agricole',sourceLabel:'Import Crédit Agricole PDF V2.1',bankImportId:bankImportKey(o.date,o.lib,o.mt)});
      count++;
    }
    closeModal('m-ca-pdf-import');
    renderCompta();
    toast(count+' opération(s) PDF importée(s) ✓');
  }catch(err){ console.error(err); toast('Erreur import PDF CA : '+(err.message||err)); }
}

let _docFilter='all';
const DOC_FILTERS={type:'all',bien:'all',associe:'all',locataire:'all',year:'all',search:''};
function gfaDocTypes(){
  return [
    ['all','Tous'],['bail_rural','Baux ruraux'],['cadastre','Cadastre'],['acte_propriete','Actes'],['safer','SAFER'],['taxe_fonciere','Taxes'],['fermage','Fermages'],['facture','Factures'],['autre','Autres']
  ];
}
function sciDocTypes(){
  return [['all','Tous'],['contrat','Contrats'],['diagnostic','Diagnostics'],['facture','Factures'],['photo','Photos'],['autre','Autres']];
}
function docTypeOptions(){ return isGFAContext()?gfaDocTypes():sciDocTypes(); }
function uniqueSorted(arr){ return [...new Set(arr.filter(Boolean).map(x=>String(x).trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr')); }
function docBienOptions(){
  const fromBiens=(window.CACHE?.biens||[]).map(b=>isGFAContext()?(b.adr||b.cadastre||b.commune):(b.adr||b.cadastre));
  const fromDocs=(window.CACHE?.docs||[]).map(d=>d.bien);
  return uniqueSorted([...fromBiens,...fromDocs]);
}
function renderDocFilterControls(){
  const typeSel=$('doc-filter-type'), bienSel=$('doc-filter-bien'), assocSel=$('doc-filter-associe'), locSel=$('doc-filter-locataire'), yearSel=$('doc-filter-year');
  const keep={type:DOC_FILTERS.type,bien:DOC_FILTERS.bien,associe:DOC_FILTERS.associe,locataire:DOC_FILTERS.locataire,year:DOC_FILTERS.year};
  if(typeSel){ typeSel.innerHTML=docTypeOptions().map(x=>`<option value="${esc(x[0])}">${esc(x[1])}</option>`).join(''); typeSel.value=keep.type||'all'; }
  if(bienSel){ bienSel.innerHTML='<option value="all">Tous les biens / parcelles</option>'+docBienOptions().map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join(''); bienSel.value=[...bienSel.options].some(o=>o.value===keep.bien)?keep.bien:'all'; DOC_FILTERS.bien=bienSel.value; }
  if(assocSel){ const vals=uniqueSorted([...(window.CACHE?.associes||[]).map(a=>[a.prenom,a.nom].filter(Boolean).join(' ')),...(window.CACHE?.docs||[]).map(d=>d.associe)]); assocSel.innerHTML='<option value="all">Tous les associés</option>'+vals.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join(''); assocSel.value=[...assocSel.options].some(o=>o.value===keep.associe)?keep.associe:'all'; DOC_FILTERS.associe=assocSel.value; }
  if(locSel){ const vals=uniqueSorted([...(window.CACHE?.locataires||[]).map(l=>[l.prenom,l.nom].filter(Boolean).join(' ')),...(window.CACHE?.docs||[]).map(d=>d.locataire)]); locSel.innerHTML='<option value="all">Tous les locataires</option>'+vals.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join(''); locSel.value=[...locSel.options].some(o=>o.value===keep.locataire)?keep.locataire:'all'; DOC_FILTERS.locataire=locSel.value; }
  if(yearSel){ const years=uniqueSorted((window.CACHE?.docs||[]).map(d=>String(d.accountingYear||String(d.date||'').slice(0,4)||''))).reverse(); yearSel.innerHTML='<option value="all">Toutes les années</option>'+years.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join(''); yearSel.value=[...yearSel.options].some(o=>o.value===keep.year)?keep.year:'all'; DOC_FILTERS.year=yearSel.value; }
  const search=$('doc-search'); if(search && search.value!==DOC_FILTERS.search) search.value=DOC_FILTERS.search||'';
}
function setDocUIForEntity(){
  const title=document.querySelector('#page-documents .sec-hdr h2');
  const sub=document.querySelector('#page-documents .sec-hdr p');
  if(title) title.textContent=isGFAContext()?'Documents GFA':'Documents';
  if(sub) sub.textContent=isGFAContext()?'Classement des baux ruraux, cadastre, actes, SAFER, taxes foncières et justificatifs.':'Classement, recherche et filtres par bien, type, associé ou locataire.';
  renderDocFilterControls();
}
function updateDocFilters(){
  DOC_FILTERS.search=($('doc-search')?.value||'').trim().toLowerCase();
  DOC_FILTERS.type=$('doc-filter-type')?.value||'all';
  DOC_FILTERS.bien=$('doc-filter-bien')?.value||'all';
  DOC_FILTERS.associe=$('doc-filter-associe')?.value||'all';
  DOC_FILTERS.locataire=$('doc-filter-locataire')?.value||'all';
  DOC_FILTERS.year=$('doc-filter-year')?.value||'all';
  _docFilter=DOC_FILTERS.type;
  renderDocs();
}
function clearDocFilters(){
  Object.assign(DOC_FILTERS,{type:'all',bien:'all',associe:'all',locataire:'all',year:'all',search:''});
  ['doc-search'].forEach(id=>{const el=$(id); if(el) el.value='';});
  renderDocs();
}
function docMatchesFilters(d){
  if(DOC_FILTERS.type && DOC_FILTERS.type!=='all' && d.type!==DOC_FILTERS.type) return false;
  if(DOC_FILTERS.bien && DOC_FILTERS.bien!=='all' && String(d.bien||'')!==DOC_FILTERS.bien) return false;
  if(DOC_FILTERS.associe && DOC_FILTERS.associe!=='all' && String(d.associe||'')!==DOC_FILTERS.associe) return false;
  if(DOC_FILTERS.locataire && DOC_FILTERS.locataire!=='all' && String(d.locataire||'')!==DOC_FILTERS.locataire) return false;
  const y=String(d.accountingYear||String(d.date||'').slice(0,4)||'');
  if(DOC_FILTERS.year && DOC_FILTERS.year!=='all' && y!==DOC_FILTERS.year) return false;
  if(DOC_FILTERS.search){
    const hay=[d.name,d.type,docTypeLabel(d.type),d.bien,d.associe,d.locataire,d.accountingType,d.accountingYear,d.date].join(' ').toLowerCase();
    if(!hay.includes(DOC_FILTERS.search)) return false;
  }
  return true;
}
function renderDocs(filter){
  if(filter){ DOC_FILTERS.type=filter; _docFilter=filter; }
  setDocUIForEntity();
  const docs=window.CACHE?.docs||[];
  const filtered=docs.filter(docMatchesFilters).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  const count=$('doc-results-count'); if(count) count.textContent=`${filtered.length} document(s) affiché(s) sur ${docs.length}`;
  const el=$('docs-grid');if(!el)return;
  el.innerHTML=filtered.length?filtered.map(d=>`
    <div class="doc-card" onclick="openStoredDoc(${d.id})">
      <button class="doc-del write-only" onclick="event.stopPropagation();confirmDel('doc-direct',${d.id})">🗑</button>
      <div class="doc-icon">${d.icon||'📄'}</div>
      <div class="doc-name">${esc(d.name)}</div>
      <div class="doc-meta">${fmtDate(d.date)}</div>
      <div class="doc-meta" style="margin-top:4px"><span class="tag tb">${esc(docTypeLabel(d.type))}</span></div>
      ${docAssocLabel(d)?`<div class="doc-meta">${esc(docAssocLabel(d))}</div>`:''}
      <div class="doc-links" onclick="event.stopPropagation()"><button onclick="openStoredDoc(${d.id})">Consulter</button><button onclick="downloadStoredDoc(${d.id})">Télécharger</button><button class="write-only doc-btn-full" onclick="openDocModal(${d.id})">Modifier</button></div>
    </div>`).join(''):'<p style="color:var(--text2);padding:20px">Aucun document ne correspond aux filtres.</p>';
}
function filterDocs(type,btn){
  DOC_FILTERS.type=type||'all';
  const sel=$('doc-filter-type'); if(sel) sel.value=DOC_FILTERS.type;
  renderDocs();
}
function linkedDocsForBien(b){
  const key1=String(b.adr||'');
  const key2=String(b.cadastre||'');
  const key3=String(b.commune||'');
  return (window.CACHE?.docs||[]).filter(d=>{
    const x=String(d.bien||'');
    return x && (x===key1 || x===key2 || x.includes(key1) || (key2 && x.includes(key2)) || (key3 && x.includes(key3)));
  }).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
}
function linkedDocsHTML(b){
  const docs=linkedDocsForBien(b);
  if(!docs.length) return '<div class="linked-docs"><div class="linked-docs-title">Documents liés</div><div class="doc-meta">Aucun document lié</div></div>';
  return `<div class="linked-docs"><div class="linked-docs-title">Documents liés (${docs.length})</div>${docs.slice(0,4).map(d=>`<div class="linked-doc-row"><span>${esc(d.name||'Document')} · ${esc(docTypeLabel(d.type))}</span><button onclick="event.stopPropagation();openStoredDoc(${d.id})">Voir</button></div>`).join('')}${docs.length>4?`<div class="doc-meta">+ ${docs.length-4} autre(s) document(s)</div>`:''}</div>`;
}
async function handleFileUpload(e){
  let file=e.target.files[0];if(!file)return;
  file=await compressImageFile(file);
  const maxMo=25;
  if(file.size>maxMo*1024*1024){toast('Fichier trop lourd : maximum '+maxMo+' Mo.'); e.target.value=''; return;}
  const ext=(file.name.split('.').pop()||'').toLowerCase();
  const icon=['jpg','jpeg','png','webp','gif'].includes(ext)?'🖼️':'📄';
  const type=isGFAContext() ? (ext==='pdf'?'cadastre':'autre') : (['jpg','jpeg','png','webp','gif'].includes(ext)?'photo':(ext==='pdf'?'diagnostic':'autre'));
  const id=Date.now();
  try{
    toast('Import du document...');
    const dataUrl = await new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(reader.error||new Error('Lecture du fichier impossible'));
      reader.readAsDataURL(file);
    });
    // Firestore limite chaque document à ~1 Mo. On découpe donc le fichier en petits morceaux.
    const chunkSize=450000;
    const totalChunks=Math.ceil(dataUrl.length/chunkSize);
    const meta={id,name:file.name,type,date:new Date().toISOString().split('T')[0],icon,mime:file.type||'',size:file.size,storageMode:'firestoreChunks',chunkCount:totalChunks,bien:'',associe:'',locataire:''};
    await window.dbSet?.('docs',meta);
    const ref=colRef('docs').doc(String(id)).collection('chunks');
    let batch=db.batch(), count=0;
    for(let i=0;i<totalChunks;i++){
      const part=dataUrl.slice(i*chunkSize,(i+1)*chunkSize);
      batch.set(ref.doc(String(i).padStart(4,'0')),{index:i,data:part});
      count++;
      if(count>=20){ await batch.commit(); batch=db.batch(); count=0; }
    }
    if(count>0) await batch.commit();
    toast('Document ajouté et consultable ✓');
  }catch(err){
    console.error('Erreur upload document',err);
    try{ await deleteDocChunks(id); await colRef('docs').doc(String(id)).delete(); }catch(_e){}
    toast('Erreur document : '+(err.code==='permission-denied'?'permissions Firebase insuffisantes pour écrire docs/chunks. Vérifie rôle gérant + règles Firestore.':(err.message||err)));
  }finally{
    e.target.value='';
  }
}

function renderAssoc(){
  const list=window.CACHE?.associes||[];
  const box=$('assoc-list'); if(!box) return;
  box.innerHTML=list.length?list.map(a=>{
    const initials=((a.prenom?.[0]||'')+(a.nom?.[0]||'')).toUpperCase()||'A';
    const name=[a.prenom,a.nom].filter(Boolean).join(' ')||'Associé';
    return `
    <div class="card assoc-compact-card" onclick="openAssocieModal(${a.id})">
      <div class="card-hd">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--gold),var(--gold2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#0f0e0c;font-size:12px;flex-shrink:0">${esc(initials)}</div>
          <div style="min-width:0"><div class="card-title">${esc(name)}</div><div class="card-sub">${esc(a.adr||'Adresse non renseignée')}</div></div>
        </div>
        <span class="tag to">${(+a.parts||0)}%</span>
      </div>
      <div class="info-row"><span>Rôle</span><span class="tag tb">${esc(a.role||'Associé')}</span></div>
      <div class="info-row"><span>Email</span><span style="font-size:11px">${esc(a.email||'—')}</span></div>
      <div class="info-row"><span>Tél.</span><span>${esc(a.tel||'—')}</span></div>
      <div class="progress"><div class="progress-bar" style="width:${Math.max(0,Math.min(100,+a.parts||0))}%"></div></div>
      <div class="card-acts" onclick="event.stopPropagation()">
        <a href="tel:${esc(a.tel||'')}" class="act-call">📞 Appeler</a>
        <a href="mailto:${esc(a.email||'')}" class="act-mail">✉️ Email</a>
      </div>
    </div>`;
  }).join(''):'<p style="color:var(--text2);padding:20px">Aucun associé.</p>';
}

// ══ MODALS BIENS ══
function fillParcelleBauxSelect(selected=''){
  const sel=$('b-bail-id'); if(!sel) return;
  sel.innerHTML='<option value="">— Aucun bail lié —</option>'+(window.CACHE?.baux||[]).map(b=>`<option value="${esc(b.id)}">${esc((b.fermier||'Fermier')+' · '+(b.type||'Bail rural'))}</option>`).join('');
  sel.value=selected||'';
}
function setBienModalMode(b={}){
  const gfa=isGFAContext();
  const extra=$('gfa-parcelle-extra'); if(extra) extra.style.display=gfa?'block':'none';
  const labels=document.querySelectorAll('#m-bien .fg label');
  const adrLbl=labels[0], typeLbl=labels[1], surfLbl=labels[2], valLbl=labels[3], loyerLbl=labels[4], statLbl=labels[5], dpeLbl=labels[6];
  if(adrLbl) adrLbl.textContent=gfa?'Localisation / lieu-dit':'Adresse complète';
  if(typeLbl) typeLbl.textContent=gfa?'Catégorie foncière':'Type';
  if(surfLbl) surfLbl.textContent=gfa?'Surface (ha)':'Surface (m²)';
  if(valLbl) valLbl.textContent=gfa?'Valeur estimée (€)':'Valeur estimée (€)';
  if(loyerLbl) loyerLbl.textContent=gfa?'Fermage annuel estimé (€)':'Loyer mensuel (€)';
  if(statLbl) statLbl.textContent=gfa?'Statut foncier':'Statut';
  if(dpeLbl) dpeLbl.textContent=gfa?'Qualité / usage':'DPE';
  const type=$('b-type'), stat=$('b-stat'), dpe=$('b-dpe');
  if(type) type.innerHTML=gfa?'<option>Terre agricole</option><option>Prairie</option><option>Bois</option><option>Verger</option><option>Bâtiment rural</option><option>Lot foncier</option><option>Autre</option>':'<option>Appartement</option><option>Maison</option><option>Studio</option><option>Local commercial</option><option>Parking</option>';
  if(stat) stat.innerHTML=gfa?'<option>Exploitée</option><option>Louée</option><option>Libre</option><option>Boisée</option><option>En travaux</option>':'<option>Loué</option><option>Vacant</option><option>En travaux</option>';
  if(dpe) dpe.innerHTML=gfa?'<option>Agricole</option><option>Prairie</option><option>Bois</option><option>Bâti rural</option><option>Mixte</option><option>Autre</option>':'<option>A</option><option>B</option><option>C</option><option>D</option><option>E</option><option>F</option><option>G</option>';
}
function openBienModal(id){
  const e=id!=null,b=e?(window.CACHE?.biens||[]).find(x=>String(x.id)===String(id)):null;
  setBienModalMode(b||{});
  $('mbien-t').innerHTML=e?(isGFAContext()?'🌾 Modifier la parcelle &nbsp;<span class="mbadge">Édition</span>':'🏠 Modifier le bien &nbsp;<span class="mbadge">Édition</span>'):(isGFAContext()?'🌾 Nouvelle parcelle':'🏠 Nouveau bien');
  $('b-del').style.display=e?'block':'none';
  fillParcelleBauxSelect(b?.bailId||'');
  if(e&&b){sv('b-id',b.id);sv('b-adr',b.adr);sv('b-type',b.type);sv('b-surf',b.surf);sv('b-val',b.val);sv('b-loyer',b.loyer);sv('b-stat',b.stat);sv('b-dpe',b.dpe);sv('b-notes',b.notes||'');sv('b-commune',b.commune||'');sv('b-cadastre',b.cadastre||'');sv('b-nature',b.nature||'Terre agricole');sv('b-exploitant',b.exploitant||'');sv('b-type-bail',b.typeBail||'Non louée');sv('b-bail-id',b.bailId||'');}
  else{['b-id','b-adr','b-surf','b-val','b-loyer','b-notes','b-commune','b-cadastre','b-exploitant'].forEach(f=>sv(f,''));sv('b-type',isGFAContext()?'Terre agricole':'Appartement');sv('b-stat',isGFAContext()?'Exploitée':'Loué');sv('b-dpe',isGFAContext()?'Agricole':'C');sv('b-nature','Terre agricole');sv('b-type-bail','Non louée');sv('b-bail-id','');}
  openModal('m-bien');
}
async function saveBien(){
  const id=v('b-id'),e=!!id;
  const base={id:e?+id:Date.now(),adr:v('b-adr'),type:v('b-type'),surf:+v('b-surf'),val:+v('b-val'),loyer:+v('b-loyer'),stat:v('b-stat'),dpe:v('b-dpe'),notes:v('b-notes')};
  const obj=isGFAContext()?{...base,commune:v('b-commune'),cadastre:v('b-cadastre'),nature:v('b-nature'),exploitant:v('b-exploitant'),typeBail:v('b-type-bail'),bailId:v('b-bail-id')}:base;
  const ok = await saveWithFeedback(window.dbSet?.('biens',obj), e?(isGFAContext()?'Parcelle mise à jour ✓':'Bien mis à jour ✓'):(isGFAContext()?'Parcelle ajoutée ✓':'Bien ajouté ✓'));
  if(ok) closeModal('m-bien');
}

// ══ MODALS LOCATAIRES ══
function openLocataireModal(id){
  const biens=window.CACHE?.biens||[];
  const sel=$('l-bien-sel');
  if(sel)sel.innerHTML='<option value="">— Sélectionner —</option>'+biens.map(b=>`<option value="${b.adr}">${b.adr}</option>`).join('');
  const e=id!=null,l=e?(window.CACHE?.locataires||[]).find(x=>x.id===id):null;
  $('mloc-t').innerHTML=e?'🧑 Modifier &nbsp;<span class="mbadge">Édition</span>':'🧑 Nouveau locataire';
  $('l-del').style.display=e?'block':'none';
  if(e&&l){sv('l-id',l.id);sv('l-prenom',l.prenom);sv('l-nom',l.nom);sv('l-tel',l.tel);sv('l-email',l.email);if(sel)sel.value=l.bien||'';sv('l-loyer',l.loyer);sv('l-charges',l.charges);sv('l-entree',l.entree);sv('l-fin',l.fin);sv('l-iban',l.iban||'');sv('l-depot',l.depot||'');sv('l-note',l.note||'');}
  else{['l-id','l-prenom','l-nom','l-tel','l-email','l-loyer','l-charges','l-entree','l-fin','l-iban','l-depot','l-note'].forEach(f=>sv(f,''));if(sel)sel.value='';}
  openModal('m-loc');
}
async function saveLoc(){
  const id=v('l-id'),e=!!id,sel=$('l-bien-sel');
  const ok = await saveWithFeedback(window.dbSet?.('locataires',{id:e?+id:Date.now(),prenom:v('l-prenom'),nom:v('l-nom'),tel:v('l-tel'),email:v('l-email'),bien:sel?.value||'',loyer:+v('l-loyer'),charges:+v('l-charges'),entree:v('l-entree'),fin:v('l-fin'),iban:v('l-iban'),depot:+v('l-depot'),note:v('l-note')}), e?'Locataire mis à jour ✓':'Locataire ajouté ✓');
  if(ok) closeModal('m-loc');
}

// ══ MODALS ASSOCIÉS ══
function openAssocieModal(id){
  const e=id!=null,a=e?(window.CACHE?.associes||[]).find(x=>x.id===id):null;
  $('massoc-t').innerHTML=e?'🤝 Modifier &nbsp;<span class="mbadge">Édition</span>':'🤝 Nouvel associé';
  $('a-del').style.display=e?'block':'none';
  if(e&&a){sv('a-id',a.id);sv('a-prenom',a.prenom);sv('a-nom',a.nom);sv('a-tel',a.tel);sv('a-email',a.email);sv('a-role',a.role);sv('a-parts',a.parts);sv('a-adr',a.adr||'');sv('a-iban',a.iban||'');}
  else{['a-id','a-prenom','a-nom','a-tel','a-email','a-parts','a-adr','a-iban'].forEach(f=>sv(f,''));sv('a-role','Associé');}
  openModal('m-assoc');
}
async function saveAssoc(){
  const id=v('a-id'),e=!!id;
  const ok = await saveWithFeedback(window.dbSet?.('associes',{id:e?+id:Date.now(),prenom:v('a-prenom'),nom:v('a-nom'),tel:v('a-tel'),email:v('a-email'),role:v('a-role'),parts:+v('a-parts'),adr:v('a-adr'),iban:v('a-iban')}), e?'Associé mis à jour ✓':'Associé ajouté ✓');
  if(ok) closeModal('m-assoc');
}

// ══ MODALS OPÉRATIONS ══
function setOpCategories(){
  const cat=$('op-cat'); if(!cat) return;
  if(isGFAContext()) cat.innerHTML='<option>Fermage</option><option>Taxe foncière</option><option>MSA / charges agricoles</option><option>Entretien foncier</option><option>Travaux ruraux</option><option>Assurance</option><option>Frais notaire / SAFER</option><option>Honoraires</option><option>Autre GFA</option>';
  else cat.innerHTML='<option>Loyer</option><option>Charges locatives</option><option>Taxe foncière</option><option>Assurance</option><option>Travaux</option><option>Honoraires</option><option>Autre</option>';
}
function openOpModal(id){
  setOpCategories();
  const biens=window.CACHE?.biens||[];
  const sel=$('op-bien');
  if(sel)sel.innerHTML='<option value="">— '+(isGFAContext()?'Toutes les parcelles':'Tous les biens')+' —</option>'+biens.map(b=>`<option value="${esc(isGFAContext()?(b.cadastre||b.adr):(b.adr))}">${esc(isGFAContext()?((b.cadastre||b.adr||'Parcelle')+' · '+(b.commune||'')):b.adr)}</option>`).join('');
  const e=id!=null,op=e?(window.CACHE?.ops||[]).find(x=>String(x.id)===String(id)):null;
  $('mop-t').innerHTML=e?(isGFAContext()?'🌾 Modifier fermage / charge &nbsp;<span class="mbadge">Édition</span>':'📊 Modifier &nbsp;<span class="mbadge">Édition</span>'):(isGFAContext()?'🌾 Nouveau fermage / charge GFA':'📊 Nouvelle opération');
  $('op-del').style.display=e?'block':'none';
  fillOpDocsSelect(op?.docId||'');
  if(e&&op){sv('op-id',op.id);sv('op-date',op.date);sv('op-type',op.type);sv('op-lib',op.lib);sv('op-mt',Math.abs(op.mt));sv('op-cat',op.cat);sv('op-pay',op.payment||'Virement');sv('op-status',op.status||'paye');sv('op-doc',op.docId||'');if(sel)sel.value=op.bien||'';}
  else{sv('op-id','');sv('op-date',new Date().toISOString().split('T')[0]);sv('op-lib','');sv('op-mt','');sv('op-type','recette');sv('op-cat',isGFAContext()?'Fermage':'Loyer');sv('op-pay','Virement');sv('op-status','paye');sv('op-doc','');if(sel)sel.value='';}
  openModal('m-op');
}
async function saveOp(){
  const id=v('op-id'),e=!!id,type=v('op-type'),mt=+v('op-mt'),sel=$('op-bien');
  const ok = await saveWithFeedback(window.dbSet?.('ops',{id:e?id:Date.now(),date:v('op-date'),type,lib:v('op-lib'),bien:sel?.value||'',cat:v('op-cat'),payment:v('op-pay'),status:v('op-status'),docId:v('op-doc'),mt:type==='recette'?mt:-mt}), e?'Opération mise à jour ✓':'Opération enregistrée ✓');
  if(ok) closeModal('m-op');
}

// ══ MODALS DOCS ══
function openDocModal(id){
  const d=(window.CACHE?.docs||[]).find(x=>x.id===id);if(!d)return;
  const typeSel=$('doc-type-sel');
  if(typeSel && isGFAContext()) typeSel.innerHTML='<option value="bail_rural">Bail rural</option><option value="cadastre">Cadastre</option><option value="acte_propriete">Acte de propriété</option><option value="safer">SAFER</option><option value="taxe_fonciere">Taxe foncière</option><option value="fermage">Fermage</option><option value="facture">Facture / justificatif</option><option value="autre">Autre</option>';
  else if(typeSel) typeSel.innerHTML='<option value="contrat">Contrat</option><option value="diagnostic">Diagnostic</option><option value="facture">Facture</option><option value="photo">Photo</option><option value="autre">Autre</option>';
  sv('doc-id',d.id);sv('doc-name-inp',d.name);sv('doc-type-sel',d.type);
  fillDocSelects(d);
  sv('doc-accounting-type',d.accountingType||''); sv('doc-accounting-year',d.accountingYear||new Date().getFullYear()); const sent=$('doc-sent-accountant'); if(sent) sent.checked=!!d.sentAccountant;
  openModal('m-doc');
}
async function saveDoc(){
  const id=+v('doc-id'),d=(window.CACHE?.docs||[]).find(x=>x.id===id);if(!d)return;
  const ok = await saveWithFeedback(window.dbSet?.('docs',{...d,name:v('doc-name-inp'),type:v('doc-type-sel'),bien:v('doc-bien-sel'),associe:v('doc-assoc-sel'),locataire:v('doc-loc-sel'),accountingType:v('doc-accounting-type'),accountingYear:+v('doc-accounting-year')||new Date().getFullYear(),sentAccountant:!!$('doc-sent-accountant')?.checked}), 'Document mis à jour ✓');
  if(ok) closeModal('m-doc');
}

// ══ CONFIRM DELETE ══
function getDeleteId(type, directId){
  if(directId !== undefined && directId !== null) return String(directId);
  const map={bien:'b-id',loc:'l-id',assoc:'a-id',op:'op-id',doc:'doc-id',ech:'ech-id',decision:'dec-id'};
  const field=map[type];
  return field ? String(v(field)) : '';
}

async function deleteWithFeedback(col, id, successMsg){
  if(!id){ toast('Erreur : identifiant introuvable'); return false; }
  try{
    await window.dbDel?.(col, id);
    toast(successMsg || 'Élément supprimé ✓');
    return true;
  }catch(err){
    console.error('Erreur suppression Firebase', err);
    toast(formatFirebaseError(err));
    return false;
  }
}

// ══ CONFIRM DELETE ══
function confirmDel(type,directId){
  const msgs={bien:'Supprimer ce bien ?',loc:'Supprimer ce locataire ?',assoc:'Supprimer cet associé ?',op:'Supprimer cette opération ?','op-direct':'Supprimer cette opération ?',doc:'Supprimer ce document ?','doc-direct':'Supprimer ce document ?',ech:'Supprimer cette échéance ?',decision:'Supprimer cette décision et ses votes ?',bail:'Supprimer ce bail rural ?', 'bail-direct':'Supprimer ce bail rural ?'};
  $('confirm-msg').textContent=msgs[type]||'Supprimer ?';
  $('confirm-ok').onclick=async()=>{
    closeModal('m-confirm');
    if(!canWrite()){ denyWrite(); return; }
    const cleanType=String(type).replace('-direct','');
    const id=getDeleteId(cleanType, directId);

    if(type==='bien'){
      const ok=await deleteWithFeedback('biens',id,'Bien supprimé ✓');
      if(ok) closeModal('m-bien');
    }
    else if(type==='loc'){
      const ok=await deleteWithFeedback('locataires',id,'Locataire supprimé ✓');
      if(ok) closeModal('m-loc');
    }
    else if(type==='assoc'){
      const ok=await deleteWithFeedback('associes',id,'Associé supprimé ✓');
      if(ok) closeModal('m-assoc');
    }
    else if(type==='op' || type==='op-direct'){
      const ok=await deleteWithFeedback('ops',id,'Opération supprimée ✓');
      if(ok) closeModal('m-op');
    }
    else if(type==='doc' || type==='doc-direct'){
      try{ await deleteDocChunks(id); }catch(e){ console.warn('Chunks document non supprimés ou absents', e); }
      const ok=await deleteWithFeedback('docs',id,'Document supprimé ✓');
      if(ok) closeModal('m-doc');
    }
    else if(type==='ech'){
      const ok=await deleteWithFeedback('echs',id,'Échéance supprimée ✓');
      if(ok) closeModal('m-ech');
    }
    else if(type==='bail' || type==='bail-direct'){
      const ok=await deleteWithFeedback('baux',id,'Bail rural supprimé ✓');
      if(ok) closeModal('m-bail');
    }
    else if(type==='decision'){
      const ok=await deleteWithFeedback('decisions',id,'Décision supprimée ✓');
      if(ok) closeModal('m-decision');
    }
  };
  openModal('m-confirm');
}


async function getCurrentStructureLegalInfo(){
  const fallback = {name:entityName(), form:isGFAContext()?'GFA':'SCI', address:'', city:'', siret:'', capital:'', email:'', phone:'', rcs:'', manager:'', notes:''};
  try{
    const snap = await db.collection('scis').doc(SCI_ID).get({source:'server'});
    const d = snap.exists ? (snap.data()||{}) : {};
    return {...fallback, ...(d.legal||{}), name:(d.legal?.name || d.nom || d.name || fallback.name)};
  }catch(e){
    console.warn('Infos légales non lues', e);
    return fallback;
  }
}
function setLegalFields(info){
  const map={name:'legal-name',form:'legal-form',siret:'legal-siret',capital:'legal-capital',email:'legal-email',phone:'legal-phone',address:'legal-address',city:'legal-city',rcs:'legal-rcs',manager:'legal-manager',notes:'legal-notes'};
  Object.entries(map).forEach(([k,id])=>sv(id, info?.[k] || ''));
}
window.openLegalInfoModal = async function(){
  if(!canWrite()){ denyWrite(); return; }
  const info = await getCurrentStructureLegalInfo();
  setLegalFields(info);
  openModal('m-legal-structure');
};
window.saveLegalInfo = async function(){
  if(!canWrite()){ denyWrite(); return; }
  const legal={
    name:v('legal-name'), form:v('legal-form'), siret:v('legal-siret'), capital:v('legal-capital'),
    email:v('legal-email'), phone:v('legal-phone'), address:v('legal-address'), city:v('legal-city'),
    rcs:v('legal-rcs'), manager:v('legal-manager'), notes:v('legal-notes')
  };
  try{
    await db.collection('scis').doc(SCI_ID).set({legal, nom:legal.name || entityName(), updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    if(APP_STATE.currentSCI) APP_STATE.currentSCI.nom = legal.name || APP_STATE.currentSCI.nom;
    applyEntityUI(); renderSCISwitcher(); closeModal('m-legal-structure'); toast('Informations légales enregistrées ✓');
  }catch(err){ console.error(err); toast('Erreur infos légales : '+formatFirebaseError(err)); }
};
function legalLine(label, value){ return value ? `<div class="legal-line"><span>${label}</span><strong>${esc(value)}</strong></div>` : ''; }

// ══ QUITTANCE ══
function genQuittanceFromLoc(locId){
  const loc=(window.CACHE?.locataires||[]).find(x=>String(x.id)===String(locId));
  if(!loc){ toast('Locataire introuvable pour générer la quittance.'); return; }
  const nom=[loc.prenom,loc.nom].filter(Boolean).join(' ') || 'Locataire';
  genQuittance(nom, loc.loyer, loc.charges, loc.bien || '');
}
async function genQuittance(nom,loyer,charges,bienLoué=''){
  const mois=new Date().toLocaleString('fr-FR',{month:'long',year:'numeric'});
  const total=(+loyer||0)+(+charges||0);
  const w=window.open('','_blank');
  if(!w){ toast('Popup bloquée : autorise les fenêtres pour générer la quittance.'); return; }
  w.document.write('<p style="font-family:Arial;padding:30px">Préparation de la quittance...</p>');
  const legal=await getCurrentStructureLegalInfo();
  const today=new Date().toLocaleDateString('fr-FR');
  const html=`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Quittance de loyer - ${esc(nom)} - ${esc(mois)}</title>
  <style>
    @page{size:A4;margin:18mm} body{font-family:Arial,Helvetica,sans-serif;color:#1f1f1f;background:#fff;margin:0;font-size:13px;line-height:1.45} .page{max-width:780px;margin:0 auto;padding:26px}
    .top{display:flex;justify-content:space-between;gap:28px;border-bottom:3px solid #c9a84c;padding-bottom:20px;margin-bottom:26px}.brand{display:flex;gap:14px;align-items:flex-start}.logo{width:58px;height:58px;border-radius:14px;background:linear-gradient(135deg,#c9a84c,#e8c97a);display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;font-weight:700;font-size:22px;color:#17130a}.brand h1{font-family:Georgia,serif;font-size:25px;margin:0 0 4px}.muted{color:#666}.small{font-size:11px}.right{text-align:right;min-width:230px}.title{font-family:Georgia,serif;text-align:center;font-size:30px;margin:24px 0 8px}.subtitle{text-align:center;color:#666;margin-bottom:28px}.box{border:1px solid #ddd;border-radius:14px;padding:18px;margin:18px 0}.box h2{font-size:15px;margin:0 0 12px;text-transform:uppercase;letter-spacing:1px;color:#8b7530}.legal-line,.row{display:flex;justify-content:space-between;gap:20px;padding:7px 0;border-bottom:1px solid #eee}.legal-line:last-child,.row:last-child{border-bottom:none}.legal-line span,.row span:first-child{color:#666}.amount{font-size:18px;font-weight:700}.total{background:#f7f1df;border:1px solid #dfcf9b;border-radius:12px;padding:14px 16px;margin-top:10px}.notice{font-size:12px;color:#555;background:#f8f8f8;border-left:4px solid #c9a84c;padding:12px 14px;margin:22px 0}.signature{margin-top:42px;display:flex;justify-content:space-between;gap:28px}.sigbox{text-align:right;min-width:230px}.print-btn{position:fixed;right:18px;top:18px;border:0;border-radius:10px;background:#c9a84c;color:#111;padding:10px 16px;font-weight:700;cursor:pointer}@media print{.print-btn{display:none}.page{padding:0}.box{break-inside:avoid}}
  </style></head><body><button class="print-btn" onclick="window.print()">Imprimer / PDF</button><main class="page">
  <section class="top"><div class="brand"><div class="logo">SF</div><div><h1>${esc(legal.name||entityName())}</h1><div class="muted">${esc(legal.form||entityType())}${legal.capital?' · Capital : '+esc(legal.capital):''}</div><div class="small muted">${esc(legal.address||'')}${legal.city?' · '+esc(legal.city):''}</div></div></div><div class="right small muted">${legal.siret?'SIRET : '+esc(legal.siret)+'<br>':''}${legal.rcs?esc(legal.rcs)+'<br>':''}${legal.email?esc(legal.email)+'<br>':''}${legal.phone?esc(legal.phone):''}</div></section>
  <h1 class="title">Quittance de loyer</h1><div class="subtitle">Période : <strong>${esc(mois)}</strong></div>
  <section class="box"><h2>Bailleur</h2>${legalLine('Structure',legal.name||entityName())}${legalLine('Adresse', [legal.address,legal.city].filter(Boolean).join(' · '))}${legalLine('Gérant / représentant',legal.manager)}${legalLine('SIRET',legal.siret)}</section>
  <section class="box"><h2>Locataire</h2><div class="row"><span>Nom</span><strong>${esc(nom)}</strong></div>${bienLoué?`<div class="row"><span>Logement loué</span><strong>${esc(bienLoué)}</strong></div>`:''}</section>
  <section class="box"><h2>Détail du règlement</h2><div class="row"><span>Loyer hors charges</span><strong>${(+loyer||0).toLocaleString('fr-FR')} €</strong></div><div class="row"><span>Provision / charges</span><strong>${(+charges||0).toLocaleString('fr-FR')} €</strong></div><div class="row total"><span>Total acquitté</span><strong class="amount">${total.toLocaleString('fr-FR')} €</strong></div></section>
  <p class="notice">Le bailleur reconnaît avoir reçu du locataire la somme indiquée ci-dessus au titre du loyer et des charges pour la période mentionnée, sous réserve d’encaissement effectif.</p>
  ${legal.notes?`<p class="notice">${esc(legal.notes)}</p>`:''}
  <section class="signature"><div><strong>Fait le ${today}</strong><br><span class="muted">Quittance générée par SCI Family</span></div><div class="sigbox"><div>Signature du bailleur</div><br><br><br><strong>${esc(legal.name||entityName())}</strong></div></section>
  </main></body></html>`;
  w.document.open(); w.document.write(html); w.document.close();
}

// ══ COMMUNICATION / DÉCISIONS ══
let currentChannel='general';
const CHANNEL_LABELS={general:'Général',compta:'Comptabilité',travaux:'Travaux',biens:'Biens',reunions:'Réunions'};
function esc(s){return String(s??'').replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m]));}
function docTypeLabel(t){
  const labels={bail_rural:'Bail rural',cadastre:'Cadastre',acte_propriete:'Acte de propriété',safer:'SAFER',taxe_fonciere:'Taxe foncière',fermage:'Fermage',facture:'Facture',contrat:'Contrat',diagnostic:'Diagnostic',photo:'Photo',autre:'Autre'};
  return labels[t] || t || 'Document';
}
function docAssocLabel(d){
  const bits=[];
  if(d.bien) bits.push('🏠 '+d.bien);
  if(d.associe) bits.push('🤝 '+d.associe);
  if(d.locataire) bits.push('🧑 '+d.locataire);
  return bits.join(' · ');
}
function accountingDocs(){
  return isGFAContext() ? (window.CACHE?.docs||[]) : (window.CACHE?.docs||[]).filter(d=>d.accountingType || ['facture','quittance'].includes(d.type));
}
function linkedDoc(op){
  if(!op || !op.docId) return null;
  return (window.CACHE?.docs||[]).find(d=>String(d.id)===String(op.docId));
}
function opNeedsDoc(op){
  if(op?.noDocRequired || op?.justificatifNotRequired) return false;
  const cat=String(op?.cat||'').toLowerCase();
  const mt=Math.abs(+op?.mt||0);
  return mt>0 && ['taxe foncière','assurance','travaux','honoraires','banque','emprunt','autre','charges locatives','loyer'].some(x=>cat.includes(x));
}
function missingJustificatifs(){
  return (window.CACHE?.ops||[]).filter(op=>opNeedsDoc(op) && !op.docId);
}
function fillOpDocsSelect(selected=''){
  const sel=$('op-doc'); if(!sel) return;
  const docs=accountingDocs().sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  sel.innerHTML='<option value="">— Aucun document lié —</option>'+docs.map(d=>`<option value="${esc(d.id)}">${esc(d.name||'Document')} · ${esc(d.accountingType||d.type||'doc')} · ${fmtDate(d.date)}</option>`).join('');
  sel.value=selected||'';
}
async function deleteDocChunks(id){
  try{
    const snap=await colRef('docs').doc(String(id)).collection('chunks').get();
    if(snap.empty) return;
    let batch=db.batch(), count=0;
    snap.docs.forEach(doc=>{
      batch.delete(doc.ref); count++;
      if(count>=400){ batch.commit(); batch=db.batch(); count=0; }
    });
    if(count>0) await batch.commit();
  }catch(err){ console.warn('Chunks document non supprimés',err); }
}
function dataUrlToBlobUrl(dataUrl){
  const parts=String(dataUrl||'').split(',');
  if(parts.length<2) throw new Error('Format document invalide');
  const mimeMatch=parts[0].match(/data:([^;]+);base64/);
  const mime=mimeMatch?mimeMatch[1]:'application/octet-stream';
  const bin=atob(parts[1]);
  const len=bin.length;
  const arr=new Uint8Array(len);
  for(let i=0;i<len;i++) arr[i]=bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr],{type:mime}));
}
async function getStoredDocDataUrl(id){
  const d=(window.CACHE?.docs||[]).find(x=>x.id===id);
  if(!d) throw new Error('Document introuvable');
  if(d.dataUrl) return d.dataUrl;
  if(d.storageMode==='firestoreChunks'){
    const snap=await colRef('docs').doc(String(id)).collection('chunks').orderBy('index').get();
    const chunks=snap.docs.map(x=>(x.data()||{}).data||'');
    if(d.chunkCount && chunks.length!==d.chunkCount) console.warn('Document incomplet', chunks.length, '/', d.chunkCount);
    return chunks.join('');
  }
  return '';
}
async function downloadStoredDoc(id){
  const d=(window.CACHE?.docs||[]).find(x=>x.id===id);
  if(!d){toast('Document introuvable');return;}
  try{
    toast('Préparation du téléchargement...');
    if(d.fileUrl){
      const a=document.createElement('a'); a.href=d.fileUrl; a.download=d.name||'document'; a.target='_blank'; document.body.appendChild(a); a.click(); a.remove(); return;
    }
    const dataUrl=await getStoredDocDataUrl(id);
    if(!dataUrl){toast('Fichier non enregistré. Réimporte-le.');return;}
    const blobUrl=dataUrlToBlobUrl(dataUrl);
    const a=document.createElement('a');
    a.href=blobUrl; a.download=d.name||'document';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(blobUrl),3000);
    toast('Téléchargement lancé ✓');
  }catch(err){console.error(err);toast('Téléchargement impossible : '+(err.message||err));}
}
async function openStoredDoc(id){
  const d=(window.CACHE?.docs||[]).find(x=>x.id===id);
  if(!d){toast('Document introuvable');return;}
  if(d.fileUrl){ window.open(d.fileUrl,'_blank'); return; }
  const w=window.open('', '_blank');
  if(!w){toast('Ouverture bloquée par le navigateur');return;}
  w.document.write('<body style="font-family:Arial;padding:30px">Chargement du document...</body>');
  try{
    let dataUrl=await getStoredDocDataUrl(id);
    if(!dataUrl){ w.close(); toast('Ancien document : fichier non enregistré. Réimporte-le une fois pour le rendre consultable.'); return; }
    const blobUrl=dataUrlToBlobUrl(dataUrl);
    const safeName=esc(d.name||'Document');
    w.document.open();
    if(String(d.mime||'').startsWith('image/')){
      w.document.write(`<title>${safeName}</title><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="${blobUrl}" style="max-width:100%;max-height:100vh;object-fit:contain"><script>window.addEventListener('beforeunload',()=>URL.revokeObjectURL('${blobUrl}'));<\/script></body>`);
    }else if(String(d.mime||'').includes('pdf') || String(d.name||'').toLowerCase().endsWith('.pdf')){
      w.document.write(`<title>${safeName}</title><body style="margin:0"><iframe src="${blobUrl}" style="border:0;width:100%;height:100vh"></iframe><div style="position:fixed;right:16px;bottom:16px"><a href="${blobUrl}" download="${safeName}" style="background:#c9a84c;color:#111;padding:10px 14px;border-radius:10px;text-decoration:none;font-family:Arial">Télécharger</a></div><script>window.addEventListener('beforeunload',()=>URL.revokeObjectURL('${blobUrl}'));<\/script></body>`);
    }else{
      w.location.href=blobUrl;
    }
    w.document.close();
  }catch(err){
    console.error('Erreur consultation document',err);
    w.close();
    toast('Impossible d’ouvrir le document : '+(err.message||err));
  }
}
function fillDocSelects(d={}){
  const bienSel=$('doc-bien-sel'), assocSel=$('doc-assoc-sel'), locSel=$('doc-loc-sel');
  if(bienSel) bienSel.innerHTML='<option value="">— Aucun —</option>'+(window.CACHE?.biens||[]).map(b=>{const label=isGFAContext()?[(b.cadastre||b.adr||'Parcelle'),b.commune].filter(Boolean).join(' · '):(b.adr||b.cadastre||'Bien'); return `<option value="${esc(label)}">${esc(label)}</option>`}).join('');
  if(assocSel) assocSel.innerHTML='<option value="">— Aucun —</option>'+(window.CACHE?.associes||[]).map(a=>{const n=[a.prenom,a.nom].filter(Boolean).join(' ');return `<option value="${esc(n)}">${esc(n)}</option>`}).join('');
  if(locSel) locSel.innerHTML='<option value="">— Aucun —</option>'+(window.CACHE?.locataires||[]).map(l=>{const n=[l.prenom,l.nom].filter(Boolean).join(' ');return `<option value="${esc(n)}">${esc(n)}</option>`}).join('');
  if(bienSel) bienSel.value=d.bien||''; if(assocSel) assocSel.value=d.associe||''; if(locSel) locSel.value=d.locataire||'';
}
function currentUserName(){
  const p=APP_STATE.profile||{}, u=auth.currentUser||{};
  return [p.prenom,p.nom].filter(Boolean).join(' ') || u.displayName || (u.email?u.email.split('@')[0]:'Utilisateur');
}
function selectChannel(ch,btn){
  currentChannel=ch;
  document.querySelectorAll('.channel-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  const lab=$('msg-channel-label'); if(lab) lab.textContent=CHANNEL_LABELS[ch]||ch;
  renderCommunication();
}
async function addActivity(type, action){
  try{ await colRef('activity').add({type,action,userUid:auth.currentUser?.uid||'',userName:currentUserName(),createdAt:firebase.firestore.FieldValue.serverTimestamp()}); }catch(e){ console.warn('Activity non enregistrée', e); }
}
async function sendMessage(){
  const txt=(v('msg-text')||'').trim();
  if(!txt){toast('Message vide');return;}
  try{
    await colRef('messages').add({channel:currentChannel,authorUid:auth.currentUser?.uid||'',authorName:currentUserName(),authorPhoto:profilePhotoUrl(),role:APP_STATE.role,message:txt,createdAt:firebase.firestore.FieldValue.serverTimestamp(),readBy:[auth.currentUser?.uid||'']});
    sv('msg-text','');
    await addActivity('message', currentUserName()+' a publié un message');
    toast('Message envoyé ✓');
  }catch(err){console.error(err);toast(formatFirebaseError(err));}
}
function canEditMessage(m){
  return !!(m && (APP_STATE.role==='gerant' || (m.authorUid && m.authorUid===auth.currentUser?.uid)));
}
function startEditMessage(id){
  const m=(window.CACHE?.messages||[]).find(x=>String(x.id)===String(id));
  if(!m || !canEditMessage(m)){toast('Vous ne pouvez modifier que vos messages.');return;}
  const box=$('msg-edit-'+String(id));
  const body=$('msg-body-'+String(id));
  if(box) box.style.display='block';
  if(body) body.style.display='none';
}
function cancelEditMessage(id){
  const box=$('msg-edit-'+String(id));
  const body=$('msg-body-'+String(id));
  if(box) box.style.display='none';
  if(body) body.style.display='block';
}
async function saveEditedMessage(id){
  const m=(window.CACHE?.messages||[]).find(x=>String(x.id)===String(id));
  if(!m || !canEditMessage(m)){toast('Vous ne pouvez modifier que vos messages.');return;}
  const txt=($('msg-edit-text-'+String(id))?.value||'').trim();
  if(!txt){toast('Message vide');return;}
  try{
    await colRef('messages').doc(String(id)).set({message:txt,editedAt:firebase.firestore.FieldValue.serverTimestamp(),editedBy:auth.currentUser?.uid||''},{merge:true});
    await addActivity('message', currentUserName()+' a modifié un message');
    toast('Message modifié ✓');
  }catch(err){console.error(err);toast(formatFirebaseError(err));}
}
async function deleteMessage(id){
  const m=(window.CACHE?.messages||[]).find(x=>String(x.id)===String(id));
  if(!m || !canEditMessage(m)){toast('Vous ne pouvez supprimer que vos messages.');return;}
  if(!confirm('Supprimer ce message ?')) return;
  try{
    await colRef('messages').doc(String(id)).delete();
    await addActivity('message', currentUserName()+' a supprimé un message');
    toast('Message supprimé ✓');
  }catch(err){console.error(err);toast(formatFirebaseError(err));}
}
function msgAvatarHtml(m){
  const name=m.authorName||'Utilisateur';
  const initials=initialsFromName(name, '');
  const photo=m.authorPhoto||'';
  return `<span class="msg-avatar">${photo?`<img src="${esc(photo)}" alt="${esc(name)}">`:esc(initials)}</span>`;
}
function renderCommunication(){
  const list=(window.CACHE?.messages||[]).filter(m=>m.channel===currentChannel).sort((a,b)=>tsMillis(b.createdAt)-tsMillis(a.createdAt));
  const el=$('messages-list'); if(!el)return;
  el.innerHTML=list.length?list.map((m,i)=>{
    const id=String(m.id||('msg'+i));
    const editable=canEditMessage(m);
    const edited=m.editedAt?`<div class="msg-edited">modifié le ${fmtTs(m.editedAt)}</div>`:'';
    return `<div class="msg-card"><div class="msg-head"><div class="msg-author-line">${msgAvatarHtml(m)}<span class="msg-author">${esc(m.authorName||'Utilisateur')}</span></div><div class="msg-actions"><button class="flag-btn write-only" onclick="flagItem('message','${esc(id)}','Message important','${esc((m.message||'').slice(0,80))}')">!</button>${editable?`<button class="msg-action-btn" onclick="startEditMessage('${esc(id)}')">✏️ Modifier</button><button class="msg-action-btn danger" onclick="deleteMessage('${esc(id)}')">🗑</button>`:''}<span class="msg-date">${fmtTs(m.createdAt)}</span></div></div><div class="msg-body" id="msg-body-${esc(id)}">${esc(m.message)}${edited}</div><div id="msg-edit-${esc(id)}" style="display:none"><textarea class="msg-edit-box" id="msg-edit-text-${esc(id)}" rows="3">${esc(m.message)}</textarea><div class="vote-row"><button class="vote-btn" onclick="saveEditedMessage('${esc(id)}')">Enregistrer</button><button class="vote-btn" onclick="cancelEditMessage('${esc(id)}')">Annuler</button></div></div></div>`;
  }).join(''):'<div class="ech-empty">Aucun message dans ce canal.</div>';
}
function tsMillis(t){ if(!t)return 0; if(typeof t.toMillis==='function')return t.toMillis(); if(t.seconds)return t.seconds*1000; return new Date(t).getTime()||0; }
function fmtTs(t){ const ms=tsMillis(t); return ms?new Date(ms).toLocaleString('fr-FR'):'—'; }
function toggleDecisionEmailOptions(){
  const en=document.getElementById('dec-email-enabled')?.checked;
  const box=document.getElementById('dec-email-options');
  if(box) box.style.display=en?'block':'none';
}
function toggleDecisionEmailReminder(){
  const en=document.getElementById('dec-email-reminder')?.checked;
  const box=document.getElementById('dec-email-reminder-options');
  if(box) box.style.display=en?'grid':'none';
}
function decisionEmailRecipientsSnapshot(){
  const includeGerants=document.getElementById('dec-email-gerants')?.checked !== false;
  const includeAssocies=document.getElementById('dec-email-associes')?.checked !== false;
  const rows=(window.CACHE?.associes||[]).filter(a=>{
    const role=String(a.role||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    const isG=role.includes('gerant');
    const isA=!isG;
    return (includeGerants && isG) || (includeAssocies && isA);
  }).map(a=>({
    id:String(a.id||''),
    name:[a.prenom,a.nom].filter(Boolean).join(' ') || a.email || 'Associé',
    email:a.email || '',
    role:a.role || 'Associé',
    voteStatus:'pending'
  })).filter(r=>r.email);
  return rows;
}
function buildDecisionEmailNotification(isEdit, previous){
  const enabled=!!document.getElementById('dec-email-enabled')?.checked;
  if(!enabled){
    return previous?.notificationEmail ? {...previous.notificationEmail, enabled:false, status:previous.notificationEmail.status||'disabled'} : {enabled:false,status:'disabled'};
  }
  const reminderEnabled=!!document.getElementById('dec-email-reminder')?.checked;
  return {
    enabled:true,
    includeGerants:document.getElementById('dec-email-gerants')?.checked !== false,
    includeAssocies:document.getElementById('dec-email-associes')?.checked !== false,
    status: previous?.notificationEmail?.status || 'prepared',
    sentAt: previous?.notificationEmail?.sentAt || null,
    preparedAt: previous?.notificationEmail?.preparedAt || new Date().toISOString(),
    reminderEnabled,
    reminderDelayDays:+(document.getElementById('dec-email-reminder-delay')?.value||2),
    reminderStatus: previous?.notificationEmail?.reminderStatus || (reminderEnabled ? 'prepared' : 'disabled'),
    reminderSentAt: previous?.notificationEmail?.reminderSentAt || null,
    recipientsSnapshot: decisionEmailRecipientsSnapshot()
  };
}
function decisionEmailStatusHtml(dec,w){
  const n=dec.notificationEmail;
  if(!n || !n.enabled) return '';
  const recipients=(n.recipientsSnapshot||[]).length;
  const missing=Math.max(0,(w?.totalAssocies||recipients)-((dec.votes||[]).length));
  const rel=n.reminderEnabled ? ` · Relance préparée J-${n.reminderDelayDays||2}` : '';
  return `<div class="note-box" style="margin-top:10px">📧 Email préparé · ${recipients} destinataire(s)${rel}<br>Votes manquants : ${missing}</div>`;
}
function openDecisionModal(id){
  if(!canWrite()){ denyWrite(); return; }
  const biens=window.CACHE?.biens||[], sel=$('dec-bien');
  if(sel) sel.innerHTML='<option value="">— Aucun —</option>'+biens.map(b=>`<option value="${esc(b.adr)}">${esc(b.adr)}</option>`).join('');
  const e=id!=null, d=e?(window.CACHE?.decisions||[]).find(x=>String(x.id)===String(id)):null;
  $('mdec-t').innerHTML=e?'🗳 Modifier la décision':'🗳 Nouvelle décision';
  $('dec-del').style.display=e?'block':'none';
  if(e&&d){
    sv('dec-id',d.id);sv('dec-title',d.title);sv('dec-type',d.type||'travaux');sv('dec-montant',d.montant||'');if(sel)sel.value=d.bien||'';sv('dec-deadline',d.deadline||'');sv('dec-description',d.description||'');
    const n=d.notificationEmail||{};
    const en=document.getElementById('dec-email-enabled'); if(en) en.checked=!!n.enabled;
    const eg=document.getElementById('dec-email-gerants'); if(eg) eg.checked=n.includeGerants!==false;
    const ea=document.getElementById('dec-email-associes'); if(ea) ea.checked=n.includeAssocies!==false;
    const er=document.getElementById('dec-email-reminder'); if(er) er.checked=!!n.reminderEnabled;
    const ed=document.getElementById('dec-email-reminder-delay'); if(ed) ed.value=String(n.reminderDelayDays||2);
  }
  else{
    sv('dec-id','');sv('dec-title','');sv('dec-type','travaux');sv('dec-montant','');if(sel)sel.value='';const dd=new Date();dd.setDate(dd.getDate()+14);sv('dec-deadline',dd.toISOString().split('T')[0]);sv('dec-description','');
    const en=document.getElementById('dec-email-enabled'); if(en) en.checked=false;
    const eg=document.getElementById('dec-email-gerants'); if(eg) eg.checked=true;
    const ea=document.getElementById('dec-email-associes'); if(ea) ea.checked=true;
    const er=document.getElementById('dec-email-reminder'); if(er) er.checked=false;
    const ed=document.getElementById('dec-email-reminder-delay'); if(ed) ed.value='2';
  }
  toggleDecisionEmailOptions();
  toggleDecisionEmailReminder();
  openModal('m-decision');
}
async function saveDecision(){
  if(!canWrite()){ denyWrite(); return; }
  const id=v('dec-id') || Date.now();
  const isEdit=!!v('dec-id');
  const previous=(window.CACHE?.decisions||[]).find(x=>String(x.id)===String(id));
  const obj={id:+id,title:v('dec-title'),type:v('dec-type'),montant:+v('dec-montant')||0,bien:v('dec-bien'),deadline:v('dec-deadline'),description:v('dec-description'),createdBy:previous?.createdBy||auth.currentUser?.uid||'',createdByName:previous?.createdByName||currentUserName(),createdAt:previous?.createdAt||firebase.firestore.FieldValue.serverTimestamp(),updatedAt:firebase.firestore.FieldValue.serverTimestamp(),notificationEmail:buildDecisionEmailNotification(isEdit, previous)};
  const ok=await saveWithFeedback(colRef('decisions').doc(String(id)).set(obj,{merge:isEdit}), isEdit?'Décision mise à jour ✓':'Décision créée ✓');
  if(ok){ closeModal('m-decision'); await addActivity('decision', currentUserName()+' a créé une décision'); }
}
function decisionWeights(dec){
  const votes=dec.votes||[];
  const count=(val)=>votes.filter(v=>v.vote===val).length;
  const totalAssocies=Math.max(1,(window.CACHE?.associes||[]).length);
  const totalVotes=votes.length;
  return {pour:count('pour'),contre:count('contre'),abstention:count('abstention'),totalVotes,totalAssocies};
}
function decisionStatus(dec){
  const w=decisionWeights(dec);
  if(!dec || !w.totalVotes) return 'pending';
  // V1.2.1 : un associé = une voix. Décision adoptée/rejetée à la majorité absolue des associés.
  if(w.pour > w.totalAssocies/2) return 'adopted';
  if(w.contre > w.totalAssocies/2) return 'rejected';
  return 'pending';
}
function myWeight(){
  return 1;
}
async function voteDecision(id,vote){
  const dec=(window.CACHE?.decisions||[]).find(x=>String(x.id)===String(id)); if(!dec)return;
  if(dec.archive?.archived){ toast('Vote archivé : modification impossible.'); return; }
  try{
    await colRef('decisions').doc(String(id)).collection('votes').doc(auth.currentUser.uid).set({vote,weight:1,voterUid:auth.currentUser.uid,voterName:currentUserName(),voterEmail:auth.currentUser?.email||'',role:APP_STATE.role,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
    await addActivity('vote', currentUserName()+' a voté sur : '+(dec.title||''));
    toast('Vote enregistré ✓');
    const vs=await colRef('decisions').doc(String(id)).collection('votes').get();
    dec.votes=vs.docs.map(d=>d.data());
    renderDecisions(); renderHome();
  }catch(err){console.error(err);toast(formatFirebaseError(err));}
}
function decisionArchiveSnapshot(dec){
  const w=decisionWeights(dec);
  const status=decisionStatus(dec);
  const voters=(dec.votes||[]).map(v=>({
    name:v.voterName||'Utilisateur',
    email:v.voterEmail||v.email||'',
    vote:v.vote||'',
    votedAt:v.createdAt||v.votedAt||null,
    userId:v.voterUid||'',
    role:v.role||''
  }));
  return {
    archived:true,
    archivedAt:new Date().toISOString(),
    archivedBy:auth.currentUser?.email||'',
    archivedByName:currentUserName(),
    status,
    result:{pour:w.pour,contre:w.contre,abstention:w.abstention,totalVotes:w.totalVotes,totalAssocies:w.totalAssocies},
    voters
  };
}
async function archiveDecision(id){
  if(!canWrite()){ denyWrite(); return; }
  const dec=(window.CACHE?.decisions||[]).find(x=>String(x.id)===String(id));
  if(!dec){ toast('Décision introuvable'); return; }
  if(dec.archive?.archived){ toast('Vote déjà archivé'); return; }
  const st=decisionStatus(dec);
  if(st==='pending' && !confirm('Ce vote est encore en attente. Voulez-vous quand même le clôturer et l’archiver ?')) return;
  try{
    await colRef('decisions').doc(String(id)).set({archive:decisionArchiveSnapshot(dec), updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    await addActivity('decision', currentUserName()+' a archivé le vote : '+(dec.title||''));
    toast('Vote clôturé et archivé ✓');
  }catch(err){ console.error(err); toast(formatFirebaseError(err)); }
}
function statusLabel(st, archived){
  if(archived) return 'ARCHIVÉ';
  if(st==='adopted') return 'ADOPTÉ';
  if(st==='rejected') return 'REJETÉ';
  return 'EN ATTENTE';
}
function voteLabel(v){ return v==='pour'?'Pour':v==='contre'?'Contre':v==='abstention'?'Abstention':(v||'—'); }
function decisionArchiveHtml(d){
  if(!d.archive?.archived) return '';
  const a=d.archive, r=a.result||{};
  const voters=(a.voters||[]).map(v=>`${esc(v.name||'Utilisateur')} — ${esc(voteLabel(v.vote))}${v.email?' · '+esc(v.email):''}${v.votedAt?' · '+fmtTs(v.votedAt):''}`).join('<br>');
  return `<div class="decision-archive-box">📦 <strong>Vote archivé</strong><br>Clôturé le ${fmtTs(a.archivedAt)} par ${esc(a.archivedByName||a.archivedBy||'—')}<br>Résultat : ${statusLabel(a.status,false)} · Pour ${r.pour||0} / Contre ${r.contre||0} / Abstention ${r.abstention||0}<br>${voters?'<div style="margin-top:6px"><strong>Votes enregistrés :</strong><br>'+voters+'</div>':''}</div>`;
}
function decisionCardHtml(d){
  const w=decisionWeights(d), st=decisionStatus(d), archived=!!d.archive?.archived, my=(d.votes||[]).find(v=>v.voterUid===auth.currentUser?.uid);
  const voteButtons=archived?`<span class="tag tb">Vote clôturé — archive non modifiable</span>`:`<button class="vote-btn" onclick="voteDecision(${d.id},'pour')">✅ Pour</button><button class="vote-btn" onclick="voteDecision(${d.id},'contre')">❌ Contre</button><button class="vote-btn" onclick="voteDecision(${d.id},'abstention')">➖ Abstention</button>${my?`<span class="tag tb">Votre vote : ${my.vote}</span>`:''}`;
  const archiveBtn=canWrite()&&!archived?`<button class="vote-btn" style="border-color:var(--blue);color:var(--blue)" onclick="archiveDecision(${d.id})">📦 Clôturer / archiver</button>`:'';
  const deleteBtn=canWrite()&&!archived?`<button class="vote-btn vote-delete-btn" onclick="confirmDel('decision',${d.id})">🗑 Supprimer</button>`:'';
  return `<div class="card" onclick="${canWrite()&&!archived?`openDecisionModal(${d.id})`:'void(0)'}"><div class="card-hd"><div><div class="card-title">${esc(d.title||'Décision sans titre')}</div><div class="card-sub">${esc(d.type||'autre')} · ${d.deadline?('limite '+fmtDate(d.deadline)):'pas de limite'} ${d.bien?'· '+esc(d.bien):''}</div></div><div style="display:flex;align-items:center;gap:8px">${!archived?`<button class="flag-btn write-only" onclick="event.stopPropagation();flagItem('decision',${d.id},'Vote à traiter','${esc(d.title||'Décision')}')">!</button>`:''}<span class="decision-status ${archived?'archived':st}">${statusLabel(st,archived)}</span></div></div><div class="divider"></div><div class="info-row"><span>Montant</span><span>${(+d.montant||0).toLocaleString('fr-FR')} €</span></div><div class="msg-body">${esc(d.description||'')}</div><div class="vote-summary"><div class="vote-pill"><strong style="color:var(--green)">${w.pour}</strong>Pour</div><div class="vote-pill"><strong style="color:var(--red)">${w.contre}</strong>Contre</div><div class="vote-pill"><strong>${w.abstention}</strong>Abst.</div></div><div class="readonly-note" style="margin-top:8px">Vote : 1 associé = 1 voix · ${w.totalVotes}/${w.totalAssocies} vote(s)</div>${decisionEmailStatusHtml(d,w)}${decisionArchiveHtml(d)}<div class="vote-row" onclick="event.stopPropagation()">${voteButtons}${archiveBtn}${deleteBtn}</div></div>`;
}
function renderDecisions(){
  const list=window.CACHE?.decisions||[];
  const set=(id,val)=>{const el=$(id);if(el)el.textContent=val;};
  set('d-pending',list.filter(d=>!d.archive?.archived && decisionStatus(d)==='pending').length);
  set('d-adopted',list.filter(d=>!d.archive?.archived && decisionStatus(d)==='adopted').length);
  set('d-rejected',list.filter(d=>!d.archive?.archived && decisionStatus(d)==='rejected').length);
  set('d-archived',list.filter(d=>d.archive?.archived).length);
  const el=$('decisions-list'); if(!el)return;
  const sorted=[...list].sort((a,b)=>tsMillis(b.archive?.archivedAt||b.createdAt)-tsMillis(a.archive?.archivedAt||a.createdAt));
  const current=sorted.filter(d=>!d.archive?.archived);
  const archived=sorted.filter(d=>d.archive?.archived);
  let html='';
  if(current.length){ html += `<div style="grid-column:1/-1"><h3 style="font-family:'Playfair Display',serif;font-size:18px;margin:4px 0 12px">Votes en cours</h3></div>` + current.map(decisionCardHtml).join(''); }
  if(archived.length){ html += `<div style="grid-column:1/-1;margin-top:8px"><h3 style="font-family:'Playfair Display',serif;font-size:18px;margin:4px 0 12px">Archives des décisions</h3></div>` + archived.map(decisionCardHtml).join(''); }
  el.innerHTML=html || '<p style="color:var(--text2);padding:20px">Aucune décision créée.</p>';
}
function generateAnnualVotesPdf(){
  const year=prompt('Année civile à exporter', String(new Date().getFullYear()));
  if(!year) return;
  const y=+year;
  const rows=(window.CACHE?.decisions||[]).filter(d=>{
    const t=d.archive?.archivedAt || d.createdAt;
    const dt=t ? new Date(tsMillis(t) || t) : null;
    return d.archive?.archived && dt && dt.getFullYear()===y;
  }).sort((a,b)=>tsMillis(a.archive?.archivedAt)-tsMillis(b.archive?.archivedAt));
  if(!rows.length){ toast('Aucun vote archivé pour '+year); return; }
  const w=window.open('', '_blank');
  if(!w){ toast('Popup bloquée : autorise les popups pour générer le PDF.'); return; }
  const body=rows.map(d=>{
    const a=d.archive||{}, r=a.result||{};
    const voters=(a.voters||[]).map(v=>`<tr><td>${esc(v.name||'')}</td><td>${esc(v.email||'')}</td><td>${esc(voteLabel(v.vote))}</td><td>${esc(fmtTs(v.votedAt))}</td><td>${esc(v.userId||'')}</td></tr>`).join('');
    return `<section><h2>${esc(d.title||'Décision')}</h2><p><strong>Type :</strong> ${esc(d.type||'')} · <strong>Statut :</strong> ${esc(statusLabel(a.status,false))} · <strong>Clôture :</strong> ${esc(fmtTs(a.archivedAt))}</p><p>${esc(d.description||'')}</p><p><strong>Résultat :</strong> Pour ${r.pour||0} · Contre ${r.contre||0} · Abstention ${r.abstention||0} · Total ${r.totalVotes||0}/${r.totalAssocies||0}</p><table><thead><tr><th>Votant</th><th>Email</th><th>Vote</th><th>Date / heure</th><th>UID Firebase</th></tr></thead><tbody>${voters}</tbody></table></section>`;
  }).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>PV votes ${year}</title><style>body{font-family:Arial,sans-serif;color:#222;padding:34px;line-height:1.45}h1{font-family:Georgia,serif}h2{font-size:18px;margin-top:26px;border-top:1px solid #ccc;padding-top:16px}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}th,td{border:1px solid #ccc;padding:7px;text-align:left}th{background:#f2f2f2}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Imprimer / enregistrer en PDF</button><h1>Procès-verbal annuel des votes — ${esc(entityName())}</h1><p>Année civile : ${esc(year)} · Généré le ${new Date().toLocaleString('fr-FR')}</p>${body}<script>setTimeout(()=>window.print(),700)<\/script></body></html>`);
  w.document.close();
}


// ══ ÉCHÉANCES ══
const ECH_ICONS={bail:'🏠',loyer:'💳',irl:'📈',taxe:'🏛️',assurance:'🛡️',travaux:'🔧',fiscal:'📝',reunion:'🤝',autre:'📌'};
const ECH_LABELS={bail:'Fin de bail',loyer:'Loyer',irl:'Révision IRL',taxe:'Taxe foncière',assurance:'Assurance',travaux:'Travaux',fiscal:'Déclaration fiscale',reunion:'Assemblée générale / Réunion SCI',autre:'Autre'};
function echUrgency(e){if(e.done)return'done';const d=Math.ceil((new Date(e.date)-new Date())/864e5);if(d<0)return'overdue';if(d<=14)return'urgent';return'upcoming';}
function echDaysLabel(e){if(e.done)return'✅';const d=Math.ceil((new Date(e.date)-new Date())/864e5);if(d<0)return`Retard ${Math.abs(d)}j`;if(d===0)return"Aujourd'hui";return`Dans ${d}j`;}
let calYear=new Date().getFullYear(),calMonth=new Date().getMonth();
function calPrev(){calMonth--;if(calMonth<0){calMonth=11;calYear--;}renderCalendar();}
function calNext(){calMonth++;if(calMonth>11){calMonth=0;calYear++;}renderCalendar();}
function renderCalendar(){
  const days=['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
  const months=['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const ct=$('cal-title');if(ct)ct.textContent=`${months[calMonth]} ${calYear}`;
  const echs=window.CACHE?.echs||[],today=new Date();today.setHours(0,0,0,0);
  let sd=new Date(calYear,calMonth,1).getDay()-1;if(sd<0)sd=6;
  const dim=new Date(calYear,calMonth+1,0).getDate(),dip=new Date(calYear,calMonth,0).getDate();
  let h=days.map(d=>`<div class="cal-head">${d}</div>`).join('');
  for(let i=sd-1;i>=0;i--)h+=`<div class="cal-day other-month"><div class="day-num">${dip-i}</div></div>`;
  for(let d=1;d<=dim;d++){
    const ds=`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const de=echs.filter(e=>e.date===ds),it=new Date(calYear,calMonth,d).getTime()===today.getTime();
    let dots=de.slice(0,2).map(e=>`<span class="cal-dot ${echUrgency(e)}" onclick="event.stopPropagation();openEchModal(${e.id})">${ECH_ICONS[e.type]||'📌'} ${e.titre}</span>`).join('');
    if(de.length>2)dots+=`<span style="font-size:10px;color:var(--text3)">+${de.length-2}</span>`;
    h+=`<div class="cal-day${it?' today':''}"><div class="day-num">${d}</div>${dots}</div>`;
  }
  const rem=(7-(sd+dim)%7)%7;
  for(let d=1;d<=rem;d++)h+=`<div class="cal-day other-month"><div class="day-num">${d}</div></div>`;
  const cg=$('cal-grid');if(cg)cg.innerHTML=h;
}
function renderEch(){
  renderCalendar();
  const echs=window.CACHE?.echs||[],today=new Date();today.setHours(0,0,0,0);
  const in90=new Date(today);in90.setDate(in90.getDate()+90);
  const tl=echs.filter(e=>{const d=new Date(e.date);return d>=today&&d<=in90;}).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const et=$('ech-timeline');if(et)et.innerHTML=tl.length?tl.map(echItemHtml).join(''):'<div class="ech-empty">🎉 Aucune échéance dans les 90 prochains jours</div>';
  const ov=echs.filter(e=>!e.done&&new Date(e.date)<today).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const ur=echs.filter(e=>!e.done&&new Date(e.date)>=today&&Math.ceil((new Date(e.date)-today)/864e5)<=14).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const up=echs.filter(e=>!e.done&&Math.ceil((new Date(e.date)-today)/864e5)>14).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const dn=echs.filter(e=>e.done);
  let h='';
  if(ov.length){h+=`<div class="urgency-sep">🔴 En retard (${ov.length})</div>`;h+=ov.map(echItemHtml).join('');}
  if(ur.length){h+=`<div class="urgency-sep">🟡 Urgent — 14 jours (${ur.length})</div>`;h+=ur.map(echItemHtml).join('');}
  if(up.length){h+=`<div class="urgency-sep">🔵 À venir (${up.length})</div>`;h+=up.map(echItemHtml).join('');}
  if(dn.length){h+=`<div class="urgency-sep">✅ Traitées (${dn.length})</div>`;h+=dn.map(echItemHtml).join('');}
  const ea=$('ech-all');if(ea)ea.innerHTML=h||'<div class="ech-empty">Aucune échéance.</div>';
  const urg=ov.length+ur.length;const su=$('s-urg');if(su)su.textContent=urg||'0';const be=$('b-ech');if(be)be.textContent=urg||echs.length;
}
function echItemHtml(e){
  const u=echUrgency(e),dl=echDaysLabel(e);
  const timing=[e.heure||'', e.duree?e.duree+' min':''].filter(Boolean).join(' · ');
  const sub=[timing,e.bien,e.loc,e.mt?e.mt.toLocaleString('fr-FR')+' €':''].filter(Boolean).join(' · ');
  return `<div class="ech-item${e.done?' done-item':''}" onclick="openEchModal(${e.id})">
    <div class="ech-icon">${ECH_ICONS[e.type]||'📌'}</div>
    <div class="ech-body"><div class="ech-title">${e.titre}</div><div class="ech-sub">${ECH_LABELS[e.type]||'Autre'}${sub?' · '+sub:''}</div>${e.notes?`<div class="ech-sub" style="font-style:italic">${e.notes}</div>`:''}</div>
    <div class="ech-right"><span class="ech-dlbl ${u}">${fmtDate(e.date)}</span><span class="days-badge ${u}">${dl}</span>
    <button class="done-toggle write-only" onclick="event.stopPropagation();toggleEchDone(${e.id})">${e.done?'↩ Rouvrir':'✓ Traiter'}</button></div>
  </div>`;
}
async function toggleEchDone(id){
  const e=(window.CACHE?.echs||[]).find(x=>x.id===id);if(!e)return;
  await saveWithFeedback(window.dbSet?.('echs',{...e,done:!e.done}), e.done?'Réouverte':'Traitée ✅');
}
function renderInviteLists(selectedEmails=[]){
  const selSet=new Set(selectedEmails||[]);
  const aBox=$('ech-invite-associes'), lBox=$('ech-invite-locataires');
  const assocs=window.CACHE?.associes||[], locs=window.CACHE?.locataires||[];
  if(aBox) aBox.innerHTML=assocs.length?assocs.map(a=>{const mail=a.email||'';return `<label class="check-line"><input type="checkbox" class="meeting-invite" value="${esc(mail)}" data-name="${esc((a.prenom||'')+' '+(a.nom||''))}" ${selSet.has(mail)?'checked':''}>${esc((a.prenom||'')+' '+(a.nom||''))}<span style="color:var(--text3);font-size:11px">${esc(mail)}</span></label>`}).join(''):'<span style="color:var(--text2);font-size:12px">Aucun associé avec email.</span>';
  if(lBox) lBox.innerHTML=locs.length?locs.map(l=>{const mail=l.email||'';return `<label class="check-line"><input type="checkbox" class="meeting-invite" value="${esc(mail)}" data-name="${esc((l.prenom||'')+' '+(l.nom||''))}" ${selSet.has(mail)?'checked':''}>${esc((l.prenom||'')+' '+(l.nom||''))}<span style="color:var(--text3);font-size:11px">${esc(mail)}</span></label>`}).join(''):'<span style="color:var(--text2);font-size:12px">Aucun locataire avec email.</span>';
}
function toggleReunionFields(){
  const box=$('ech-reunion-fields'); if(box) box.style.display=v('ech-type')==='reunion'?'block':'none';
}
function selectedMeetingGuests(){
  return Array.from(document.querySelectorAll('.meeting-invite:checked')).filter(i=>i.value).map(i=>({email:i.value,name:i.dataset.name||i.value}));
}
function openEchModal(id){
  const biens=window.CACHE?.biens||[],locs=window.CACHE?.locataires||[];
  const sb=$('ech-bien'),sl=$('ech-loc'),typeSel=$('ech-type');
  if(typeSel) typeSel.onchange=toggleReunionFields;
  if(sb)sb.innerHTML='<option value="">— Tous les biens —</option>'+biens.map(b=>`<option value="${esc(b.adr)}">${esc(b.adr)}</option>`).join('');
  if(sl)sl.innerHTML='<option value="">— Aucun —</option>'+locs.map(l=>`<option value="${esc(l.prenom+' '+l.nom)}">${esc(l.prenom+' '+l.nom)}</option>`).join('');
  const e=id!=null,ec=e?(window.CACHE?.echs||[]).find(x=>x.id===id):null;
  $('mech-t').innerHTML=e?'📅 Modifier &nbsp;<span class="mbadge">Édition</span>':'📅 Nouvelle échéance';
  $('ech-del').style.display=e?'block':'none';
  renderInviteLists(ec?.guests?.map(g=>g.email)||[]);
  if(e&&ec){sv('ech-id',ec.id);sv('ech-titre',ec.titre);sv('ech-date',ec.date);sv('ech-type',ec.type);sv('ech-heure',ec.heure||'');sv('ech-duree',ec.duree||'');sv('ech-lieu',ec.lieu||'');if(sb)sb.value=ec.bien||'';if(sl)sl.value=ec.loc||'';sv('ech-mt',ec.mt||'');sv('ech-notes',ec.notes||'');const ed=$('ech-done');if(ed)ed.checked=!!ec.done;}
  else{sv('ech-id','');sv('ech-titre','');sv('ech-mt','');sv('ech-notes','');sv('ech-type','bail');sv('ech-heure','');sv('ech-duree','60');sv('ech-lieu','');if(sb)sb.value='';if(sl)sl.value='';const ed=$('ech-done');if(ed)ed.checked=false;const dd=new Date();dd.setDate(dd.getDate()+30);sv('ech-date',dd.toISOString().split('T')[0]);}
  toggleReunionFields();
  openModal('m-ech');
}
async function saveEch(){
  const id=v('ech-id'),e=!!id,sb=$('ech-bien'),sl=$('ech-loc'),ed=$('ech-done');
  const obj={id:e?+id:Date.now(),titre:v('ech-titre'),date:v('ech-date'),type:v('ech-type'),bien:sb?.value||'',loc:sl?.value||'',mt:+v('ech-mt')||0,notes:v('ech-notes'),done:ed?.checked||false,heure:v('ech-heure'),duree:+v('ech-duree')||0,lieu:v('ech-lieu'),guests:selectedMeetingGuests()};
  const ok = await saveWithFeedback(window.dbSet?.('echs',obj), e?'Échéance mise à jour ✓':'Échéance ajoutée ✓');
  if(ok) closeModal('m-ech');
}
function sendMeetingEmails(){
  const guests=selectedMeetingGuests();
  if(!guests.length){toast('Sélectionne au moins un invité');return;}
  const subject='Convocation réunion SCI Family';
  const body=`Bonjour,

Vous êtes convié(e) à une réunion SCI Family.

Sujet : ${v('ech-titre')}
Date : ${fmtDate(v('ech-date'))}
Heure : ${v('ech-heure')||'à préciser'}
Durée : ${v('ech-duree')?v('ech-duree')+' minutes':'à préciser'}
Lieu / Visio : ${v('ech-lieu')||'à préciser'}

Ordre du jour / notes :
${v('ech-notes')||'-'}

Merci de confirmer votre présence.

Cordialement,
SCI Family`;
  window.location.href=`mailto:${guests.map(g=>g.email).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}



// ══ ALERTES ACCUEIL ══
function myVotedDecision(d){ return (d.votes||[]).some(v=>v.voterUid===auth.currentUser?.uid); }
function getPendingItems(){
  const uid=auth.currentUser?.uid||'';
  const prefs=getHomePreferences();
  const allowed=new Set(prefs.alerts||DEFAULT_HOME_ALERT_KEYS);
  const decisions=allowed.has('vote')?(window.CACHE?.decisions||[]).filter(d=>decisionStatus(d)==='pending'&&!myVotedDecision(d)).map(d=>({type:'vote',title:'Vote en attente',text:d.title||'Décision à voter',action:()=>{closeModal('m-alerts');goPage('associes');}})):[];
  const flagged=(window.CACHE?.alerts||[]).filter(a=>!(a.dismissedBy||[]).includes(uid)).filter(a=>{
    const t=a.type||'flagged';
    return allowed.has(t) || (t==='alerte'&&allowed.has('flagged'));
  }).map(a=>({type:a.type||'alerte',title:a.title||'Alerte',text:a.text||'',id:a.id,action:()=>openAlertTarget(a)}));
  const meetings=allowed.has('reunion')?(window.CACHE?.echs||[]).filter(e=>!e.done&&new Date(e.date)>=new Date()&&(e.type==='reunion'||e.heure||e.duree)).sort((a,b)=>new Date(a.date)-new Date(b.date)).map(e=>{
    const details=[fmtDate(e.date), e.heure?'à '+e.heure:'', e.duree?e.duree+' min':''].filter(Boolean).join(' · ');
    return {type:'reunion',title:e.type==='reunion'?'Rendez-vous à venir':'Échéance avec horaire',text:(e.titre||'Échéance')+' · '+details,action:()=>{closeModal('m-alerts');goPage('echeances');}};
  }):[];
  return [...flagged,...decisions,...meetings];
}
function renderHomeAlerts(){
  const items=getPendingItems();
  const panel=$('home-alert-panel'), list=$('home-alert-list'), count=$('home-alert-count'), badge=$('b-alerts');
  if(count) count.textContent=items.length;
  if(badge) badge.textContent=items.length; const hk=$('home-alert-kpi'); if(hk) hk.textContent=items.length;
  if(!panel||!list)return;
  panel.style.display=items.length?'block':'none';
  list.innerHTML=items.slice(0,4).map((it,i)=>`<div class="alert-item" onclick="openAlertsModal()"><strong>${esc(it.title)}</strong><span>${esc(it.text)}</span></div>`).join('');
}
function openAlertsModal(){
  const items=getPendingItems(), box=$('alerts-modal-list');
  if(box) box.innerHTML=items.length?items.map((it,i)=>`<div class="ech-item" onclick="window.__alertAction${i}&&window.__alertAction${i}()"><div class="ech-icon">${it.type==='vote'?'🗳':it.type==='reunion'?'🤝':'❗'}</div><div class="ech-body"><div class="ech-title">${esc(it.title)}</div><div class="ech-sub">${esc(it.text)}</div></div><div class="ech-right"><span class="days-badge urgent">À voir</span></div></div>`).join(''):'<div class="ech-empty">Aucune alerte en cours.</div>';
  items.forEach((it,i)=>window['__alertAction'+i]=it.action);
  openModal('m-alerts');
}
function openAlertTarget(a){
  closeModal('m-alerts');
  if(a.type==='message') goPage('communication');
  else if(a.type==='decision') goPage('associes');
  else if(a.type==='document') goPage('documents');
  else goPage('home');
}
async function flagItem(type, refId, title, text){
  if(!canWrite()){ denyWrite(); return; }
  try{
    await colRef('alerts').add({id:Date.now(),type,refId:String(refId||''),title,text,createdBy:auth.currentUser?.uid||'',createdByName:currentUserName(),createdAt:firebase.firestore.FieldValue.serverTimestamp(),dismissedBy:[]});
    toast('Mis en avant sur l’accueil ✓');
  }catch(err){console.error(err);toast(formatFirebaseError(err));}
}

// ══ PRÉPARER COMPTABLE V1.1 ══
function budgetConsumptionPct(){
  const year=new Date().getFullYear();
  const chargesPrev=(window.CACHE?.budgets||[]).filter(b=>+b.year===year&&b.type==='charge').reduce((s,b)=>s+(+b.mt||0),0);
  const chargesReal=(window.CACHE?.ops||[]).filter(o=>new Date(o.date).getFullYear()===year&&(+o.mt||0)<0).reduce((s,o)=>s+Math.abs(+o.mt||0),0);
  if(!chargesPrev) return '—';
  return Math.round((chargesReal/chargesPrev)*100)+'%';
}
function renderComptable(){
  const ops=window.CACHE?.ops||[];
  const docs=accountingDocs();
  const missing=missingJustificatifs();
  const unsent=docs.filter(d=>!d.sentAccountant);
  const set=(id,val)=>{const el=$(id); if(el) el.textContent=val;};
  set('pc-ops',ops.length); set('pc-missing',missing.length); set('pc-unsent',unsent.length); set('pc-budget',budgetConsumptionPct());
  const mt=$('pc-missing-table');
  if(mt) mt.innerHTML=missing.length?missing.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).map(op=>`<tr><td>${fmtDate(op.date)}</td><td>${esc(op.lib||'—')}</td><td><span class="tag ${(+op.mt||0)>0?'tg':'tr'}">${esc(op.cat||'Autre')}</span></td><td class="${(+op.mt||0)>0?'apos':'aneg'}">${(+op.mt||0)>0?'+':''}${Math.abs(+op.mt||0).toLocaleString('fr-FR')} €</td><td><button class="btn-out btn-sm write-only" onclick="openOpModal('${esc(op.id)}')">Lier justificatif</button></td></tr>`).join(''):'<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:18px">Aucune opération sans justificatif détectée.</td></tr>';
  const dt=$('pc-docs-table');
  if(dt) dt.innerHTML=docs.length?docs.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).map(d=>{
    const linkedOps=ops.filter(o=>String(o.docId||'')===String(d.id)).length;
    return `<tr><td>${fmtDate(d.date)}</td><td>${esc(d.name||'Document')}</td><td><span class="tag tb">${esc(d.accountingType||d.type||'doc')}</span></td><td>${linkedOps?linkedOps+' opération(s)':'—'}</td><td>${d.sentAccountant?'<span class="doc-ok">Transmis</span>':'<span class="doc-missing">À transmettre</span>'}</td></tr>`;
  }).join(''):'<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:18px">Aucun document comptable classé.</td></tr>';
}
function exportComptableCSV(){
  const header=['Date','Libelle','Bien','Categorie','Type','Montant','Paiement','Statut','Justificatif','Transmis comptable'];
  const docs=window.CACHE?.docs||[];
  const rows=(window.CACHE?.ops||[]).map(o=>{const d=docs.find(x=>String(x.id)===String(o.docId||''));return [o.date||'',o.lib||'',o.bien||'',o.cat||'',(+o.mt||0)>=0?'recette':'charge',String(o.mt||0).replace('.',','),o.payment||'',o.status||'',d?.name||'',d?.sentAccountant?'oui':'non'];});
  const csv=[header,...rows].map(r=>r.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(';')).join('\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download='dossier-comptable-sci-family.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Export comptable créé ✓');
}
async function markAllDocsSent(){
  if(!canWrite()){ denyWrite(); return; }
  const docs=accountingDocs().filter(d=>!d.sentAccountant);
  if(!docs.length){ toast('Aucun document à marquer'); return; }
  if(!confirm('Marquer tous les documents comptables comme transmis au comptable ?')) return;
  try{
    for(const d of docs){ await window.dbSet?.('docs',{...d,sentAccountant:true}); }
    toast('Documents marqués transmis ✓');
  }catch(err){ console.error(err); toast(formatFirebaseError(err)); }
}

// ══ SCIapp — interface entre module Firebase et script app ══
window.SCIapp={
  init(){
    initTheme();
    document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',ev=>{if(ev.target===o)o.classList.remove('open');}));
    const td=$('today-date');if(td)td.textContent=new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    loadAccountProfile();
    renderSCISwitcher();
    renderHome();
    renderStorageUsage();
    applyRoleUI();
  },
  onData(col){
    const active=document.querySelector('.page.active')?.id?.replace('page-','');
    renderHome(); renderStorageUsage();
    if(active==='mes-scis')renderMesSCIs();
    if(active==='biens')renderBiens();
    else if(active==='locataires')renderLoc();
    else if(active==='compta')renderCompta();
    else if(active==='comptable')renderComptable();
    else if(active==='documents')renderDocs();
    else if(active==='associes')renderAssoc();
    else if(active==='echeances')renderEch();
    else if(active==='communication')renderCommunication();
    else if(active==='decisions')renderDecisions();
    applyRoleUI();
  },
  toast,
};

// Init thème immédiatement (avant auth)
initTheme();


// ══ RESPONSIVE V1.0.1 : libellés mobiles pour les tableaux ══
function applyMobileTableLabels(){
  document.querySelectorAll('.table-wrap table').forEach(table=>{
    const headers=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(tr=>{
      [...tr.children].forEach((td,i)=>{
        if(!td.getAttribute('data-label')) td.setAttribute('data-label', headers[i] || '');
      });
    });
  });
}
const _sciResponsiveObserver = new MutationObserver(()=>applyMobileTableLabels());
document.addEventListener('DOMContentLoaded',()=>{
  applyMobileTableLabels();
  _sciResponsiveObserver.observe(document.body,{childList:true,subtree:true});
});

/* Inline script 3 id="vie-sci-visuel-tabs" */
(function(){
  window.setVieSciTab=function(tab){
    ['associes','ag','votes','regles'].forEach(function(t){
      var p=document.getElementById('vie-panel-'+t); if(p) p.classList.toggle('active',t===tab);
      document.querySelectorAll('[data-vie-tab="'+t+'"]').forEach(function(b){b.classList.toggle('active',t===tab);});
    });
    var page=document.getElementById('page-associes'); if(page) page.scrollIntoView({behavior:'smooth',block:'start'});
  };
  window.updateVieSciVisualKpis=function(){
    var C=window.CACHE||{};
    var ass=(C.associes||[]).length;
    var dec=(C.decisions||[]).filter(function(d){return !(d.archive&&d.archive.archived) && (typeof decisionStatus==='function'?decisionStatus(d)==='pending':true);}).length;
    var ags=(C.echs||[]).filter(function(e){return e&&e.ag===true;});
    var next=ags.filter(function(a){return a.status!=='done';}).sort(function(a,b){return String(a.date||'9999').localeCompare(String(b.date||'9999'));})[0];
    var set=function(id,v){var el=document.getElementById(id); if(el) el.textContent=v;};
    set('vie-kpi-associes',ass||'0');
    set('vie-kpi-votes',dec||'0');
    set('vie-kpi-ag', next ? (typeof fmtDate==='function'?fmtDate(next.date):next.date) : 'Juridique');
    set('vie-kpi-ag-sub',next ? (next.titre||next.title||'AG active') : 'Aucune AG active');
  };
  var oldRenderAssoc=window.renderAssoc;
  if(typeof oldRenderAssoc==='function') window.renderAssoc=function(){ oldRenderAssoc.apply(this,arguments); setTimeout(window.updateVieSciVisualKpis,0); };
  var oldRenderDecisions=window.renderDecisions;
  if(typeof oldRenderDecisions==='function') window.renderDecisions=function(){ oldRenderDecisions.apply(this,arguments); setTimeout(window.updateVieSciVisualKpis,0); };
  var oldRenderAgs=window.renderAgs;
  if(typeof oldRenderAgs==='function') window.renderAgs=function(){ oldRenderAgs.apply(this,arguments); setTimeout(window.updateVieSciVisualKpis,0); };
  document.addEventListener('DOMContentLoaded',function(){setTimeout(window.updateVieSciVisualKpis,600);});
})();

/* Inline script 4 id="vie-sci-export-ajouts-minimaux" */
// Ajouts ciblés SCI Family — ne remplace pas l'univers graphique existant.
(function(){
  function safeRows(rows){ return Array.isArray(rows) ? rows : []; }
  function agRows(){ return safeRows(window.CACHE?.echs).filter(e=>e && e.ag===true).sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))); }
  function selectedValues(selector){ return Array.from(document.querySelectorAll(selector+':checked')).map(i=>i.value).filter(Boolean); }
  function selectedAgMembers(){ return Array.from(document.querySelectorAll('.ag-member-check:checked')).map(i=>({email:i.value,name:i.dataset.name||i.value,present:true,role:i.dataset.role||''})); }
  function selectedAgDecisions(){ return selectedValues('.ag-decision-check'); }
  function assocName(a){ return [a.prenom,a.nom].filter(Boolean).join(' ') || a.email || 'Associé'; }
  function decTitle(d){ return d.title || d.titre || 'Décision'; }

  window.renderAgs=function(){
    const ags=agRows().sort((a,b)=>String(a.date||'9999').localeCompare(String(b.date||'9999'))), assocs=safeRows(window.CACHE?.associes), decs=safeRows(window.CACHE?.decisions);
    const planned=ags.filter(a=>a.status!=='done').length;
    const done=ags.filter(a=>a.status==='done').length;
    if($('ag-planned')) $('ag-planned').textContent=planned;
    if($('ag-done')) $('ag-done').textContent=done;
    if($('ag-votes')) $('ag-votes').textContent=decs.length;
    if($('ag-members')) $('ag-members').textContent=assocs.length;
    const box=$('ags-list'); if(!box) return;
    box.innerHTML=ags.length ? ags.map(ag=>{
      const members=safeRows(ag.members), linked=safeRows(ag.decisionIds);
      const president=ag.president||'—', secretary=ag.secretary||'—';
      return `<div class="card" onclick="openAgModal(${ag.id})">
        <div class="card-hd"><div><div class="card-title">${esc(ag.titre||ag.title||'Assemblée générale')}</div><div class="card-sub">${esc(fmtDate(ag.date)||'Date non renseignée')} ${ag.heure?'· '+esc(ag.heure):''} · ${esc(ag.kind||'AGO')}</div></div><span class="tag ${ag.status==='done'?'tg':'to'}">${ag.status==='done'?'Clôturée':'Agenda'}</span></div>
        <div class="ag-card-meta">
          <div class="mini"><b>${members.length}/${assocs.length||members.length||0}</b>Présents</div>
          <div class="mini"><b>${linked.length}</b>Votes liés</div>
          <div class="mini"><b>${esc(ag.status==='done'?'PV':'À venir')}</b>Statut</div>
        </div>
        <div class="info-row"><span>Lieu</span><span>${esc(ag.lieu||ag.place||'—')}</span></div>
        <div class="info-row"><span>Président</span><span>${esc(president)}</span></div>
        <div class="info-row"><span>Secrétaire</span><span>${esc(secretary)}</span></div>
        <div class="note-box">${esc((ag.agenda||ag.notes||'Ordre du jour à compléter').slice(0,160))}</div>
        <div class="card-acts" onclick="event.stopPropagation()"><button class="act-edit" onclick="openAgModal(${ag.id})">Modifier</button><button class="act-call" onclick="goPage('echeances')">Agenda</button><button class="act-mail" onclick="generateAgPdf(${ag.id})">Rapport</button></div>
      </div>`;
    }).join('') : '<p style="color:var(--text2);padding:20px">Aucune assemblée générale planifiée.</p>';
  };

  window.fillAgLists=function(ag){
    const membersBox=$('ag-members-box'), decBox=$('ag-decisions-box');
    const selectedMembers=new Set(safeRows(ag?.members).map(m=>m.email||m.name));
    const selectedDecisions=new Set(safeRows(ag?.decisionIds).map(String));
    const assocs=safeRows(window.CACHE?.associes);
    if(membersBox) membersBox.innerHTML = assocs.length ? assocs.map(a=>{
      const name=assocName(a), val=a.email||name;
      return `<label class="check-line"><input type="checkbox" class="ag-member-check" value="${esc(val)}" data-name="${esc(name)}" data-role="${esc(a.role||'Associé')}" ${selectedMembers.has(val)||selectedMembers.has(name)?'checked':''}>${esc(name)}<span style="color:var(--text3);font-size:11px">${esc(a.role||'Associé')}</span></label>`;
    }).join('') : '<span style="color:var(--text2);font-size:12px">Ajoute d’abord des associés.</span>';
    const decs=safeRows(window.CACHE?.decisions);
    if(decBox) decBox.innerHTML = decs.length ? decs.map(d=>`<label class="check-line"><input type="checkbox" class="ag-decision-check" value="${esc(d.id)}" ${selectedDecisions.has(String(d.id))?'checked':''}>${esc(decTitle(d))}<span style="color:var(--text3);font-size:11px">${esc(d.status||'vote')}</span></label>`).join('') : '<span style="color:var(--text2);font-size:12px">Aucun vote enregistré pour le moment.</span>';
  };

  window.openAgModal=function(id){
    const ag=id!=null ? agRows().find(x=>String(x.id)===String(id)) : null;
    if($('mag-t')) $('mag-t').innerHTML=ag?'🏛️ Modifier l’AG &nbsp;<span class="mbadge">Vie de la SCI</span>':'🏛️ Nouvelle assemblée générale';
    if($('ag-del')) $('ag-del').style.display=ag?'block':'none';
    sv('ag-id', ag?.id || ''); sv('ag-title', ag?.titre || ag?.title || ''); sv('ag-date', ag?.date || new Date().toISOString().slice(0,10)); sv('ag-time', ag?.heure || '18:00'); sv('ag-place', ag?.lieu || ag?.place || ''); sv('ag-president', ag?.president || ''); sv('ag-secretary', ag?.secretary || ''); sv('ag-convocation-date', ag?.convocationDate || ''); sv('ag-kind', ag?.kind || 'AGO'); sv('ag-agenda', ag?.agenda || ''); sv('ag-status', ag?.status || 'planned'); sv('ag-notes', ag?.notes || ''); sv('ag-conclusion', ag?.conclusion || '');
    fillAgLists(ag);
    openModal('m-ag');
  };

  window.saveAg=async function(){
    if(!canWrite()){ denyWrite(); return; }
    const id=v('ag-id'), existing=id?agRows().find(x=>String(x.id)===String(id)):null;
    const date=v('ag-date'), heure=v('ag-time')||'18:00', title=v('ag-title')||'Assemblée générale';
    const obj={...(existing||{}),id:id?+id:Date.now(),ag:true,type:'reunion',titre:title,title, date,heure,lieu:v('ag-place'),place:v('ag-place'),agenda:v('ag-agenda'),kind:v('ag-kind')||'AGO',president:v('ag-president'),secretary:v('ag-secretary'),convocationDate:v('ag-convocation-date'),status:v('ag-status')||'planned',notes:v('ag-notes'),conclusion:v('ag-conclusion'),members:selectedAgMembers(),decisionIds:selectedAgDecisions(),done:v('ag-status')==='done',source:'ag',calendarLabel:'Assemblée générale SCI'};
    const ok=await saveWithFeedback(window.dbSet?.('echs',obj), id?'Assemblée générale mise à jour dans l’agenda ✓':'Assemblée générale ajoutée à l’agenda ✓');
    if(ok){ closeModal('m-ag'); renderAgs(); renderEch?.(); renderHomeAgenda?.(); }
  };

  window.deleteAgFromModal=async function(){
    const id=v('ag-id'); if(!id || !confirm('Supprimer cette assemblée générale ?')) return;
    try{ await colRef('echs').doc(String(id)).delete(); closeModal('m-ag'); toast('Assemblée générale supprimée ✓'); }catch(err){ console.error(err); toast(formatFirebaseError(err)); }
  };

  window.generateAgPdf=function(id){
    const ag=agRows().find(x=>String(x.id)===String(id)); if(!ag){ toast('AG introuvable'); return; }
    const allAssocs=safeRows(window.CACHE?.associes);
    const decs=safeRows(window.CACHE?.decisions).filter(d=>safeRows(ag.decisionIds).map(String).includes(String(d.id)));
    const members=safeRows(ag.members);
    const absentAssocs=allAssocs.filter(a=>{const n=assocName(a), e=a.email||n; return !members.some(m=>(m.email||m.name)===e || m.name===n);});
    const votesHtml=decs.length?decs.map(d=>{const r=d.archive?.result||{}; const votes=safeRows(d.votes); return `<tr><td>${esc(decTitle(d))}</td><td>${esc(d.status||'')}</td><td>${r.totalVotes||votes.length||0}</td><td>Pour ${r.pour||0} · Contre ${r.contre||0} · Abst. ${r.abstention||0}</td></tr>`;}).join(''):'<tr><td colspan="4">Aucun vote rattaché.</td></tr>';
    const membersHtml=members.length?members.map(m=>`<tr><td>${esc(m.name||m.email)}</td><td>${esc(m.email||'')}</td><td>${esc(m.role||'Associé')}</td><td>Présent</td></tr>`).join(''):'<tr><td colspan="4">Aucun membre sélectionné.</td></tr>';
    const absentHtml=absentAssocs.length?absentAssocs.map(a=>`<tr><td>${esc(assocName(a))}</td><td>${esc(a.email||'')}</td><td>${esc(a.role||'Associé')}</td><td>Absent / non coché</td></tr>`).join(''):'<tr><td colspan="4">Aucun absent identifié.</td></tr>';
    const quorum = allAssocs.length ? Math.round((members.length/allAssocs.length)*100) : 0;
    const w=window.open('', '_blank'); if(!w){ toast('Popup bloquée'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(ag.titre)}</title><style>body{font-family:Arial,sans-serif;color:#222;padding:34px;line-height:1.45}h1{font-family:Georgia,serif;margin-bottom:4px}.muted{color:#666;font-size:12px}.box{border:1px solid #ddd;background:#f8f8f8;padding:12px;margin:14px 0}h2{font-size:18px;margin-top:24px;border-top:1px solid #ccc;padding-top:14px}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}th,td{border:1px solid #ccc;padding:7px;text-align:left}th{background:#f2f2f2}.sign{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:45px}.sign div{border-top:1px solid #222;padding-top:8px}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Imprimer / enregistrer en PDF</button><h1>Rapport / Procès-verbal d’assemblée générale</h1><p class="muted">Document généré depuis SCI Family</p><div class="box"><p><strong>Structure :</strong> ${esc(entityName())}</p><p><strong>Type :</strong> ${esc(ag.kind||'AGO')}<br><strong>Titre :</strong> ${esc(ag.titre)}<br><strong>Date :</strong> ${esc(fmtDate(ag.date))} ${esc(ag.heure||'')}<br><strong>Lieu :</strong> ${esc(ag.lieu||'—')}<br><strong>Date de convocation :</strong> ${esc(fmtDate(ag.convocationDate)||'—')}</p><p><strong>Président de séance :</strong> ${esc(ag.president||'—')}<br><strong>Secrétaire de séance :</strong> ${esc(ag.secretary||'—')}<br><strong>Présents :</strong> ${members.length}/${allAssocs.length||members.length||0} (${quorum} %)</p></div><h2>Ordre du jour</h2><p>${esc(ag.agenda||'—').replace(/\n/g,'<br>')}</p><h2>Personnes présentes</h2><table><thead><tr><th>Membre</th><th>Email</th><th>Rôle</th><th>Statut</th></tr></thead><tbody>${membersHtml}</tbody></table><h2>Personnes absentes / non cochées</h2><table><thead><tr><th>Membre</th><th>Email</th><th>Rôle</th><th>Statut</th></tr></thead><tbody>${absentHtml}</tbody></table><h2>Votes et résolutions intégrés</h2><table><thead><tr><th>Décision</th><th>Statut</th><th>Votes</th><th>Résultat</th></tr></thead><tbody>${votesHtml}</tbody></table><h2>Compte rendu</h2><p>${esc(ag.notes||'—').replace(/\n/g,'<br>')}</p><h2>Conclusion / suites à donner</h2><p>${esc(ag.conclusion||'—').replace(/\n/g,'<br>')}</p><div class="sign"><div>Président de séance</div><div>Secrétaire de séance</div></div><script>setTimeout(()=>window.print(),700)<\/script></body></html>`);
    w.document.close();
  };

  window.generateAgSummaryPdf=function(){
    const ags=agRows(); if(!ags.length){ toast('Aucune AG à exporter'); return; }
    const last=ags.slice().sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')))[0]; generateAgPdf(last.id);
  };

  window.exportApplicationJSON=function(){
    const payload={exportedAt:new Date().toISOString(),structure:entityName(),data:{biens:safeRows(window.CACHE?.biens),locataires:safeRows(window.CACHE?.locataires),associes:safeRows(window.CACHE?.associes),operations:safeRows(window.CACHE?.ops),budgets:safeRows(window.CACHE?.budgets),documents:safeRows(window.CACHE?.docs).map(d=>({...d,dataUrl:undefined})),messages:safeRows(window.CACHE?.messages),decisions:safeRows(window.CACHE?.decisions),echeances:safeRows(window.CACHE?.echs),baux:safeRows(window.CACHE?.baux),settings:safeRows(window.CACHE?.settings)}};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url; a.download='sci-family-export-'+new Date().toISOString().slice(0,10)+'.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast('Sauvegarde JSON créée ✓');
  };

  window.exportApplicationXLSX=function(){
    if(typeof XLSX==='undefined'){ toast('Librairie Excel non chargée'); return; }
    const wb=XLSX.utils.book_new();
    const sheets={
      'Biens':safeRows(window.CACHE?.biens),'Locataires':safeRows(window.CACHE?.locataires),'Associes':safeRows(window.CACHE?.associes),'Operations':safeRows(window.CACHE?.ops),'Budget':safeRows(window.CACHE?.budgets),'Documents':safeRows(window.CACHE?.docs).map(d=>({id:d.id,nom:d.name,type:d.type,date:d.date,bien:d.bien,associe:d.associe,locataire:d.locataire,taille:d.size,stockage:d.storageMode,transmisComptable:d.sentAccountant?'oui':'non'})),'Messages':safeRows(window.CACHE?.messages),'Decisions':safeRows(window.CACHE?.decisions).map(d=>({id:d.id,titre:decTitle(d),type:d.type,statut:d.status,deadline:d.deadline,montant:d.montant,description:d.description,votes:safeRows(d.votes).length})),'Echeances_AG':safeRows(window.CACHE?.echs),'Baux_GFA':safeRows(window.CACHE?.baux)
    };
    Object.entries(sheets).forEach(([name,rows])=>XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows.length?rows:[{info:'Aucune donnée'}]),name.slice(0,31)));
    XLSX.writeFile(wb,'sci-family-export-complet-'+new Date().toISOString().slice(0,10)+'.xlsx'); toast('Export Excel complet créé ✓');
  };

  const oldRenderAssoc=window.renderAssoc;
  if(typeof oldRenderAssoc==='function'){
    window.renderAssoc=function(){ oldRenderAssoc.apply(this,arguments); try{ renderAgs(); }catch(e){ console.warn(e); } };
  }
})();

/* Inline script 5 id="vie-sci-pv-ag-seul-fonctionnel" */
(function(){
  function rows(name){ return Array.isArray(window.CACHE && window.CACHE[name]) ? window.CACHE[name] : []; }
  function htmlEscape(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }
  function val(id){ var el=document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
  function setVal(id,value){ var el=document.getElementById(id); if(el) el.value = value || ''; }
  function today(){ return new Date().toISOString().slice(0,10); }
  function fmtLocalDate(date){
    if(!date) return '—';
    if(typeof window.fmtDate === 'function') return window.fmtDate(date);
    try{return new Date(date).toLocaleDateString('fr-FR');}catch(e){return date;}
  }
  function currentEntityName(){
    try{ if(typeof window.entityName === 'function') return window.entityName(); }catch(e){}
    var title=document.getElementById('active-structure-title');
    return (title && title.textContent.trim()) || 'SCI';
  }
  function notify(msg){
    if(typeof window.toast === 'function') window.toast(msg); else alert(msg);
  }
  function openModalSafe(id){
    if(typeof window.openModal === 'function'){
      window.openModal(id);
      return;
    }
    var el=document.getElementById(id);
    if(el){ el.classList.add('open'); el.style.display='flex'; }
  }
  function closeModalSafe(id){
    if(typeof window.closeModal === 'function'){
      window.closeModal(id);
      return;
    }
    var el=document.getElementById(id);
    if(el){ el.classList.remove('open'); el.style.display='none'; }
  }

  function agRows(){
    return rows('echs').filter(function(e){ return e && (e.ag === true || e.type === 'ag' || /assembl|ag/i.test(String(e.titre || e.title || ''))); })
      .sort(function(a,b){ return String(a.date || '').localeCompare(String(b.date || '')); });
  }
  function assocName(a){ return [a.prenom, a.nom].filter(Boolean).join(' ') || a.nom || a.email || 'Associé'; }

  function fillAgSelect(){
    var select=document.getElementById('pv-ag-select');
    if(!select) return;
    var ags=agRows();
    var html='<option value="">— PV hors AG enregistrée / saisie libre —</option>';
    html += ags.map(function(ag){
      var label=(ag.titre || ag.title || 'Assemblée générale') + (ag.date ? ' — ' + fmtLocalDate(ag.date) : '');
      return '<option value="'+htmlEscape(ag.id || ag._id || '')+'">'+htmlEscape(label)+'</option>';
    }).join('');
    select.innerHTML=html;
  }

  function fillPvMembers(selectedNames){
    var box=document.getElementById('pv-members-box');
    if(!box) return;
    var selected=new Set(selectedNames || []);
    var associes=rows('associes');
    if(!associes.length){
      box.innerHTML='<span style="color:var(--text2);font-size:12px">Aucun associé trouvé. Tu peux quand même rédiger le PV dans les champs libres.</span>';
      return;
    }
    box.innerHTML=associes.map(function(a){
      var name=assocName(a);
      var role=a.role || 'Associé';
      return '<label class="check-line"><input type="checkbox" class="pv-member-check" value="'+htmlEscape(name)+'" data-role="'+htmlEscape(role)+'" '+(selected.has(name)?'checked':'')+'> '+htmlEscape(name)+' <span style="color:var(--text3);font-size:11px">'+htmlEscape(role)+'</span></label>';
    }).join('');
  }

  window.prefillPvFromAg = function(){
    var agId=val('pv-ag-select');
    var ag=agRows().find(function(item){ return String(item.id || item._id || '') === String(agId); });
    if(!ag) return;
    setVal('pv-kind', ag.kind || ag.categorie || 'AGO');
    setVal('pv-date', ag.date || today());
    setVal('pv-start-time', ag.heure || ag.time || '18:00');
    setVal('pv-place', ag.lieu || ag.place || '');
    setVal('pv-president', ag.president || '');
    setVal('pv-secretary', ag.secretary || ag.secretaire || '');
    setVal('pv-agenda', ag.agenda || ag.description || '');
    setVal('pv-debates', ag.notes || '');
    setVal('pv-conclusion', ag.conclusion || '');
    var names=(ag.members || ag.membres || []).map(function(m){ return m.name || m.nom || m.email || String(m); });
    fillPvMembers(names);
  };

  window.addPvResolution = function(data){
    var list=document.getElementById('pv-resolutions-list');
    if(!list) return;
    var d=data || {};
    var index=list.querySelectorAll('.pv-resolution-card').length + 1;
    var card=document.createElement('div');
    card.className='pv-resolution-card';
    card.innerHTML =
      '<div class="pv-res-head"><strong>Résolution '+index+'</strong><button type="button" class="btn-del btn-sm" onclick="this.closest(\'.pv-resolution-card\').remove()">Supprimer</button></div>'+
      '<div class="fg"><label>Intitulé / texte de la résolution</label><textarea class="pv-res-text" rows="3" placeholder="Ex : L’assemblée générale approuve les comptes de l’exercice...">'+htmlEscape(d.text || '')+'</textarea></div>'+
      '<div class="frow"><div class="fg"><label>Résultat</label><select class="pv-res-result"><option value="adoptée">Adoptée</option><option value="rejetée">Rejetée</option><option value="reportée">Reportée</option></select></div><div class="fg"><label>Règle de vote</label><input class="pv-res-rule" type="text" value="'+htmlEscape(d.rule || '1 associé = 1 voix')+'"></div></div>'+
      '<div class="frow"><div class="fg"><label>Voix pour</label><input class="pv-res-pour" type="number" min="0" value="'+htmlEscape(d.pour || '')+'"></div><div class="fg"><label>Voix contre</label><input class="pv-res-contre" type="number" min="0" value="'+htmlEscape(d.contre || '')+'"></div></div>'+
      '<div class="frow"><div class="fg"><label>Abstentions</label><input class="pv-res-abstention" type="number" min="0" value="'+htmlEscape(d.abstention || '')+'"></div><div class="fg"><label>Commentaire</label><input class="pv-res-comment" type="text" value="'+htmlEscape(d.comment || '')+'"></div></div>';
    list.appendChild(card);
    if(d.result){ var sel=card.querySelector('.pv-res-result'); if(sel) sel.value=d.result; }
  };

  function collectPv(){
    var agId=val('pv-ag-select');
    var ag=agRows().find(function(item){ return String(item.id || item._id || '') === String(agId); });
    var members=Array.from(document.querySelectorAll('.pv-member-check:checked')).map(function(input){
      return {name:input.value, role:input.dataset.role || 'Associé'};
    });
    var resolutions=Array.from(document.querySelectorAll('.pv-resolution-card')).map(function(card, idx){
      return {
        number:idx+1,
        text:(card.querySelector('.pv-res-text') || {}).value || '',
        result:(card.querySelector('.pv-res-result') || {}).value || '',
        rule:(card.querySelector('.pv-res-rule') || {}).value || '1 associé = 1 voix',
        pour:(card.querySelector('.pv-res-pour') || {}).value || '0',
        contre:(card.querySelector('.pv-res-contre') || {}).value || '0',
        abstention:(card.querySelector('.pv-res-abstention') || {}).value || '0',
        comment:(card.querySelector('.pv-res-comment') || {}).value || ''
      };
    });
    return {
      id:val('pv-id') || String(Date.now()),
      agId:agId,
      agTitle:(ag && (ag.titre || ag.title)) || 'Assemblée générale',
      kind:val('pv-kind') || 'AGO',
      date:val('pv-date'),
      startTime:val('pv-start-time'),
      endTime:val('pv-end-time'),
      place:val('pv-place'),
      president:val('pv-president'),
      secretary:val('pv-secretary'),
      members:members,
      documents:val('pv-documents'),
      agenda:val('pv-agenda'),
      debates:val('pv-debates'),
      resolutions:resolutions,
      conclusion:val('pv-conclusion')
    };
  }

  function buildPvHtml(pv){
    var membersHtml = pv.members.length ? pv.members.map(function(m){
      return '<tr><td>'+htmlEscape(m.name)+'</td><td>'+htmlEscape(m.role)+'</td><td>Présent ou représenté</td></tr>';
    }).join('') : '<tr><td colspan="3">Aucun associé coché.</td></tr>';

    var resolutionsHtml = pv.resolutions.length ? pv.resolutions.map(function(r){
      return '<h2>Résolution '+r.number+'</h2>'+
        '<p>'+htmlEscape(r.text || '—').replace(/\n/g,'<br>')+'</p>'+
        '<table><thead><tr><th>Résultat</th><th>Pour</th><th>Contre</th><th>Abstention</th><th>Règle</th></tr></thead><tbody><tr><td>'+htmlEscape(r.result)+'</td><td>'+htmlEscape(r.pour)+'</td><td>'+htmlEscape(r.contre)+'</td><td>'+htmlEscape(r.abstention)+'</td><td>'+htmlEscape(r.rule)+'</td></tr></tbody></table>'+
        (r.comment ? '<p><strong>Commentaire :</strong> '+htmlEscape(r.comment)+'</p>' : '');
    }).join('') : '<p>Aucune résolution renseignée.</p>';

    return '<!doctype html><html><head><meta charset="utf-8"><title>PV AG SCI</title>'+
      '<style>body{font-family:Arial,sans-serif;color:#1f2937;padding:36px;line-height:1.45}h1{font-family:Georgia,serif;font-size:26px;margin-bottom:4px}h2{font-size:17px;margin-top:24px;border-top:1px solid #d1d5db;padding-top:14px}.muted{color:#6b7280;font-size:12px}.box{border:1px solid #d1d5db;background:#f9fafb;border-radius:8px;padding:13px 15px;margin:16px 0}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}th,td{border:1px solid #d1d5db;padding:7px;text-align:left;vertical-align:top}th{background:#f3f4f6}.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:50px}.sign div{border-top:1px solid #111827;padding-top:8px;min-height:55px}.topbtn{margin-bottom:18px;padding:8px 12px;border:1px solid #9ca3af;border-radius:8px;background:white;cursor:pointer}@media print{.topbtn{display:none}body{padding:16px}}</style></head><body>'+
      '<button class="topbtn" onclick="window.print()">Imprimer / enregistrer en PDF</button>'+
      '<h1>Procès-verbal d’assemblée générale</h1><p class="muted">Document généré depuis SCI Family</p>'+
      '<div class="box"><p><strong>Société :</strong> '+htmlEscape(currentEntityName())+'<br><strong>Assemblée :</strong> '+htmlEscape(pv.agTitle)+'<br><strong>Type :</strong> '+htmlEscape(pv.kind)+'<br><strong>Date :</strong> '+htmlEscape(fmtLocalDate(pv.date))+'<br><strong>Heure d’ouverture :</strong> '+htmlEscape(pv.startTime || '—')+'<br><strong>Lieu :</strong> '+htmlEscape(pv.place || '—')+'</p><p><strong>Président de séance :</strong> '+htmlEscape(pv.president || '—')+'<br><strong>Secrétaire de séance :</strong> '+htmlEscape(pv.secretary || '—')+'<br><strong>Règle de vote :</strong> 1 associé = 1 voix</p></div>'+
      '<h2>Associés présents ou représentés</h2><table><thead><tr><th>Associé</th><th>Qualité</th><th>Statut</th></tr></thead><tbody>'+membersHtml+'</tbody></table>'+
      '<h2>Documents et rapports soumis</h2><p>'+htmlEscape(pv.documents || '—').replace(/\n/g,'<br>')+'</p>'+
      '<h2>Ordre du jour</h2><p>'+htmlEscape(pv.agenda || '—').replace(/\n/g,'<br>')+'</p>'+
      '<h2>Résumé des débats</h2><p>'+htmlEscape(pv.debates || '—').replace(/\n/g,'<br>')+'</p>'+
      resolutionsHtml+
      '<h2>Clôture de séance</h2><p>La séance est levée à '+htmlEscape(pv.endTime || '—')+'.</p><p>'+htmlEscape(pv.conclusion || '').replace(/\n/g,'<br>')+'</p>'+
      '<div class="sign"><div>Président de séance</div><div>Secrétaire de séance</div></div>'+
      '<script>setTimeout(function(){window.print()},700)<\/script></body></html>';
  }

  function exportPvPdf(pv){
    var w=window.open('', '_blank');
    if(!w){ notify('Popup bloquée : autorise les fenêtres pop-up pour générer le PDF.'); return; }
    w.document.open();
    w.document.write(buildPvHtml(pv));
    w.document.close();
  }

  window.openPvAgModal = function(id){
    fillAgSelect();
    fillPvMembers([]);
    setVal('pv-id', id || '');
    setVal('pv-kind', 'AGO');
    setVal('pv-date', today());
    setVal('pv-start-time', '18:00');
    setVal('pv-end-time', '');
    setVal('pv-place', '');
    setVal('pv-president', '');
    setVal('pv-secretary', '');
    setVal('pv-documents', '');
    setVal('pv-agenda', '');
    setVal('pv-debates', '');
    setVal('pv-conclusion', '');
    var list=document.getElementById('pv-resolutions-list');
    if(list) list.innerHTML='';
    window.addPvResolution({text:'Approbation des comptes de l’exercice', result:'adoptée', rule:'1 associé = 1 voix'});
    openModalSafe('m-pv-ag');
  };

  window.savePvAg = async function(generatePdf){
    var pv=collectPv();
    if(!pv.date){ notify('Date du procès-verbal à renseigner.'); return; }
    if(!pv.place){ notify('Lieu de réunion à renseigner.'); return; }
    try{
      if(window.canWrite && window.canWrite() && typeof window.dbSet === 'function'){
        await window.dbSet('pvs', pv);
        if(!generatePdf) notify('Procès-verbal enregistré ✓');
      }
    }catch(e){ console.warn('Enregistrement PV impossible, export maintenu', e); }
    if(generatePdf){ exportPvPdf(pv); }
    else { closeModalSafe('m-pv-ag'); }
  };
})();

/* Inline script 6 id="patch-pouvoir-minimal-v112" */
(function(){
  function $(id){ return document.getElementById(id); }
  function val(id){ var el=$(id); return el ? (el.value || '').trim() : ''; }
  function setVal(id,v){ var el=$(id); if(el) el.value = v || ''; }
  function esc(s){ return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function notify(msg){ if(typeof window.toast==='function') window.toast(msg); else alert(msg); }
  function today(){ return new Date().toISOString().slice(0,10); }
  function storageKey(){
    var sci = (window.currentSciId || window.ACTIVE_SCI_ID || (window.CURRENT_SCI && window.CURRENT_SCI.id) || 'default');
    return 'sci_family_pouvoirs_' + sci;
  }
  function getPouvoirs(){
    try { return JSON.parse(localStorage.getItem(storageKey()) || '[]'); }
    catch(e){ return []; }
  }
  function setPouvoirs(list){ localStorage.setItem(storageKey(), JSON.stringify(list || [])); }
  function fullName(a){ return [a.prenom, a.nom].filter(Boolean).join(' ') || a.nom || a.name || a.email || 'Associé'; }
  function associes(){ return (window.CACHE && Array.isArray(window.CACHE.associes)) ? window.CACHE.associes : []; }
  function ags(){ return (window.CACHE && Array.isArray(window.CACHE.echs)) ? window.CACHE.echs.filter(function(e){return e && e.ag===true;}) : []; }
  function fillSelect(selectId, rows, placeholder, labelFn){
    var s=$(selectId); if(!s) return;
    s.innerHTML = '<option value="">' + esc(placeholder) + '</option>';
    rows.forEach(function(r,i){
      var opt=document.createElement('option');
      opt.value = r.id || r._id || String(i);
      opt.textContent = labelFn ? labelFn(r,i) : String(r);
      s.appendChild(opt);
    });
  }
  function selectedText(id){ var s=$(id); return s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].textContent : ''; }
  function openModal(id){ var m=$(id); if(m) m.classList.add('open'); }
  function closeModal(id){ if(typeof window.closeModal==='function') window.closeModal(id); else { var m=$(id); if(m) m.classList.remove('open'); } }

  window.openPouvoirModal = function(){
    fillSelect('pouvoir-ag-select', ags(), '— AG non précisée —', function(a){ return (a.titre || a.title || 'Assemblée générale') + (a.date ? ' — ' + a.date : ''); });
    fillSelect('pouvoir-mandant', associes(), 'Choisir la personne qui donne pouvoir', fullName);
    fillSelect('pouvoir-mandataire', associes(), 'Choisir la personne qui reçoit pouvoir', fullName);
    setVal('pouvoir-id','');
    setVal('pouvoir-date', today());
    setVal('pouvoir-type','general');
    setVal('pouvoir-consignes','');
    setVal('pouvoir-notes','');
    openModal('m-pouvoir');
  };

  function collectPouvoir(){
    return {
      id: val('pouvoir-id') || ('pouvoir_' + Date.now()),
      agId: val('pouvoir-ag-select'),
      agLabel: selectedText('pouvoir-ag-select'),
      mandantId: val('pouvoir-mandant'),
      mandantLabel: selectedText('pouvoir-mandant'),
      mandataireId: val('pouvoir-mandataire'),
      mandataireLabel: selectedText('pouvoir-mandataire'),
      date: val('pouvoir-date') || today(),
      type: val('pouvoir-type'),
      consignes: val('pouvoir-consignes'),
      notes: val('pouvoir-notes'),
      createdAt: new Date().toISOString()
    };
  }

  window.savePouvoir = function(generatePdf){
    var p = collectPouvoir();
    if(!p.mandantId){ notify('Choisis la personne qui donne pouvoir.'); return; }
    if(!p.mandataireId){ notify('Choisis la personne qui reçoit le pouvoir.'); return; }
    if(p.mandantId === p.mandataireId){ notify('Le mandant et le mandataire doivent être deux personnes différentes.'); return; }
    var list = getPouvoirs().filter(function(x){ return x.id !== p.id; });
    list.unshift(p);
    setPouvoirs(list);
    notify('Pouvoir enregistré ✓');
    if(generatePdf){ generatePouvoirPdf(p); }
    else { closeModal('m-pouvoir'); }
  };

  function generatePouvoirPdf(p){
    var w = window.open('', '_blank');
    if(!w){ notify('Popup bloquée : autorise les fenêtres pop-up pour générer le PDF.'); return; }
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>Pouvoir SCI</title>'+
      '<style>body{font-family:Arial,sans-serif;color:#222;padding:42px;line-height:1.5}h1{font-family:Georgia,serif}.box{border:1px solid #ddd;background:#f8f8f8;padding:14px;margin:18px 0}.sign{display:grid;grid-template-columns:1fr 1fr;gap:36px;margin-top:60px}.sign div{border-top:1px solid #222;padding-top:8px}@media print{button{display:none}}</style></head><body>'+
      '<button onclick="window.print()">Imprimer / enregistrer en PDF</button>'+
      '<h1>Pouvoir / procuration d’assemblée générale</h1>'+
      '<div class="box"><p><strong>Assemblée concernée :</strong> '+esc(p.agLabel || '—')+'</p><p><strong>Date de signature :</strong> '+esc(p.date)+'</p></div>'+
      '<p>Je soussigné(e), <strong>'+esc(p.mandantLabel)+'</strong>, donne pouvoir à <strong>'+esc(p.mandataireLabel)+'</strong> afin de me représenter lors de l’assemblée générale indiquée ci-dessus.</p>'+
      '<p>Le mandataire pourra participer aux discussions et prendre part aux votes au nom du mandant, selon les consignes éventuellement précisées ci-dessous.</p>'+
      '<h2>Consignes éventuelles</h2><p>'+esc(p.consignes || 'Aucune consigne particulière.').replace(/\n/g,'<br>')+'</p>'+
      '<h2>Observations</h2><p>'+esc(p.notes || '—').replace(/\n/g,'<br>')+'</p>'+
      '<div class="sign"><div>Signature du mandant</div><div>Signature du mandataire</div></div>'+
      '<script>setTimeout(function(){window.print()},700)<\/script></body></html>';
    w.document.open(); w.document.write(html); w.document.close();
  }
})();

/* Inline script 7 id="sci-family-export-json-parametres" */
(function(){
  function rows(value){ return Array.isArray(value) ? value : []; }
  function cloneWithoutHeavyFiles(item){
    if(!item || typeof item !== 'object') return item;
    var copy = Object.assign({}, item);
    delete copy.dataUrl; delete copy.base64; delete copy.content; delete copy.chunks;
    return copy;
  }
  function safeEntityName(){
    try{ if(typeof window.entityName === 'function') return window.entityName(); }catch(e){}
    var title = document.getElementById('active-structure-title');
    return title && title.textContent ? title.textContent.trim() : 'SCI';
  }
  function slug(text){
    return String(text || 'sci').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'') || 'sci';
  }
  function downloadBlob(filename, content, type){
    var blob = new Blob([content], {type:type || 'application/octet-stream'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }
  function downloadJSON(filename, data){
    downloadBlob(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  }
  function dataSets(){
    var cache = window.CACHE || {};
    var echs = rows(cache.echs);
    return {
      comptabilite: rows(cache.ops),
      budget: rows(cache.budgets),
      biens: rows(cache.biens),
      locataires: rows(cache.locataires),
      documents: rows(cache.docs).map(cloneWithoutHeavyFiles),
      associes: rows(cache.associes),
      echeances: echs,
      messages: rows(cache.messages),
      decisions: rows(cache.decisions),
      assembleesGenerales: echs.filter(function(e){ return e && (e.ag || e.source === 'ag'); }),
      procesVerbaux: rows(cache.pvs),
      pouvoirs: rows(cache.pouvoirs),
      bauxGFA: rows(cache.baux),
      parametres: rows(cache.settings)
    };
  }
  function exportPayload(){
    return {
      application: 'SCI Family',
      exportVersion: 'export-parametres-v2',
      exportedAt: new Date().toISOString(),
      structure: safeEntityName(),
      data: dataSets()
    };
  }
  function flattenValue(value){
    if(value == null) return '';
    if(value instanceof Date) return value.toISOString();
    if(typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  function toCSV(list){
    list = rows(list);
    var keys = [];
    list.forEach(function(item){
      if(item && typeof item === 'object') Object.keys(item).forEach(function(k){ if(keys.indexOf(k) === -1) keys.push(k); });
    });
    if(!keys.length) keys = ['aucune_donnee'];
    var sep = ';';
    var lines = [keys.join(sep)];
    list.forEach(function(item){
      lines.push(keys.map(function(k){
        var cell = flattenValue(item && item[k]);
        cell = cell.replace(/\r?\n/g, ' ');
        return '"' + cell.replace(/"/g, '""') + '"';
      }).join(sep));
    });
    return '\ufeff' + lines.join('\n');
  }
  function sheetName(name){
    return String(name || 'Export').replace(/[\\/?*\[\]:]/g,' ').slice(0,31) || 'Export';
  }
  window.exportSCIDataJSON = function(){
    try{
      var date = new Date().toISOString().slice(0,10);
      downloadJSON('sci-family-export-donnees-' + slug(safeEntityName()) + '-' + date + '.json', exportPayload());
      if(typeof window.toast === 'function') window.toast('Export JSON créé ✓');
    }catch(err){
      console.error('Export JSON SCI Family impossible', err);
      if(typeof window.toast === 'function') window.toast('Export impossible : ' + (err.message || err));
      else alert('Export impossible : ' + (err.message || err));
    }
  };
  window.exportSCIDataCSV = function(moduleName){
    try{
      var sel = document.getElementById('export-module-select');
      var key = moduleName || (sel ? sel.value : 'comptabilite');
      var sets = dataSets();
      var list = rows(sets[key]);
      var date = new Date().toISOString().slice(0,10);
      downloadBlob('sci-family-' + key + '-' + slug(safeEntityName()) + '-' + date + '.csv', toCSV(list), 'text/csv;charset=utf-8');
      if(typeof window.toast === 'function') window.toast('Export CSV ' + key + ' créé ✓');
    }catch(err){
      console.error('Export CSV SCI Family impossible', err);
      if(typeof window.toast === 'function') window.toast('Export CSV impossible : ' + (err.message || err));
      else alert('Export CSV impossible : ' + (err.message || err));
    }
  };

  function cleanFilename(name, fallback){
    var s = String(name || fallback || 'document').trim();
    s = s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 120);
    return s || (fallback || 'document');
  }
  function extensionFromDoc(doc, dataUrl){
    var name = String(doc && doc.name || '');
    var m = name.match(/\.([a-z0-9]{2,8})$/i);
    if(m) return m[1].toLowerCase();
    var mime = String((doc && doc.mime) || '').toLowerCase();
    if(!mime && dataUrl){ var mm = String(dataUrl).match(/^data:([^;]+);/); if(mm) mime = mm[1].toLowerCase(); }
    if(mime.indexOf('pdf')>=0) return 'pdf';
    if(mime.indexOf('jpeg')>=0 || mime.indexOf('jpg')>=0) return 'jpg';
    if(mime.indexOf('png')>=0) return 'png';
    if(mime.indexOf('webp')>=0) return 'webp';
    return 'bin';
  }
  function dataUrlToUint8Array(dataUrl){
    var txt = String(dataUrl || '');
    var comma = txt.indexOf(',');
    if(comma < 0) throw new Error('Format de document invalide');
    var b64 = txt.slice(comma + 1);
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  async function ensureJSZipReady(){
    if(window.JSZip) return window.JSZip;
    await new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      s.onload = resolve;
      s.onerror = function(){ reject(new Error('JSZip non chargé')); };
      document.head.appendChild(s);
    });
    if(!window.JSZip) throw new Error('JSZip non disponible');
    return window.JSZip;
  }
  async function getDocDataUrlForZip(doc){
    if(!doc) return '';
    if(doc.dataUrl) return doc.dataUrl;
    if(doc.storageMode === 'firestoreChunks' && typeof colRef === 'function'){
      var snap = await colRef('docs').doc(String(doc.id)).collection('chunks').orderBy('index').get();
      return snap.docs.map(function(x){ return (x.data() || {}).data || ''; }).join('');
    }
    return '';
  }
  window.exportAllDocumentsZip = async function(){
    try{
      var docs = rows((window.CACHE || {}).docs);
      if(!docs.length){ if(window.toast) toast('Aucun document à télécharger'); else alert('Aucun document à télécharger'); return; }
      await ensureJSZipReady();
      if(window.toast) toast('Création du ZIP documents...');
      var zip = new JSZip();
      var manifest = [];
      var added = 0;
      for(var i=0;i<docs.length;i++){
        var d = docs[i] || {};
        try{
          var dataUrl = await getDocDataUrlForZip(d);
          var baseName = cleanFilename(d.name, 'document-' + (i+1));
          var ext = extensionFromDoc(d, dataUrl);
          if(!/\.[a-z0-9]{2,8}$/i.test(baseName)) baseName += '.' + ext;
          var uniqueName = String(i+1).padStart(3,'0') + ' - ' + baseName;
          if(dataUrl){
            zip.file(uniqueName, dataUrlToUint8Array(dataUrl));
            added++;
            manifest.push({nom:baseName, statut:'inclus', type:d.type||'', date:d.date||'', id:d.id||''});
          }else if(d.fileUrl){
            zip.file(uniqueName.replace(/\.[a-z0-9]{2,8}$/i,'') + ' - lien.txt', 'Document stocké via lien externe :\n' + d.fileUrl + '\n');
            manifest.push({nom:baseName, statut:'lien externe inclus en TXT', type:d.type||'', date:d.date||'', id:d.id||''});
          }else{
            zip.file(uniqueName.replace(/\.[a-z0-9]{2,8}$/i,'') + ' - non disponible.txt', 'Fichier non disponible dans le stockage local/Firebase chunks.\nMétadonnées :\n' + JSON.stringify(d, null, 2));
            manifest.push({nom:baseName, statut:'fichier non disponible', type:d.type||'', date:d.date||'', id:d.id||''});
          }
        }catch(oneErr){
          zip.file(String(i+1).padStart(3,'0') + ' - erreur-document.txt', 'Impossible d’exporter ce document :\n' + (oneErr.message || oneErr) + '\n\nMétadonnées :\n' + JSON.stringify(d, null, 2));
          manifest.push({nom:d.name||('document '+(i+1)), statut:'erreur: '+(oneErr.message||oneErr), type:d.type||'', date:d.date||'', id:d.id||''});
        }
      }
      zip.file('MANIFESTE-DOCUMENTS.json', JSON.stringify({application:'SCI Family', structure:safeEntityName(), exportedAt:new Date().toISOString(), totalDocuments:docs.length, fichiersInclus:added, documents:manifest}, null, 2));
      var blob = await zip.generateAsync({type:'blob'});
      var date = new Date().toISOString().slice(0,10);
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'sci-family-documents-' + slug(safeEntityName()) + '-' + date + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 3000);
      if(window.toast) toast('ZIP documents créé ✓');
    }catch(err){
      console.error('Export ZIP documents impossible', err);
      if(window.toast) toast('Export ZIP impossible : ' + (err.message || err));
      else alert('Export ZIP impossible : ' + (err.message || err));
    }
  };

  window.exportSCIDataExcel = function(){
    try{
      if(!window.XLSX){
        if(typeof window.toast === 'function') window.toast('Librairie Excel non chargée. Utilise le JSON ou CSV.');
        else alert('Librairie Excel non chargée.');
        return;
      }
      var payload = exportPayload();
      var wb = XLSX.utils.book_new();
      var meta = [{application:payload.application, structure:payload.structure, exportVersion:payload.exportVersion, exportedAt:payload.exportedAt}];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(meta), 'Infos export');
      Object.keys(payload.data).forEach(function(key){
        var list = rows(payload.data[key]).map(function(item){
          if(!item || typeof item !== 'object') return {valeur: flattenValue(item)};
          var out = {};
          Object.keys(item).forEach(function(k){ out[k] = flattenValue(item[k]); });
          return out;
        });
        if(!list.length) list = [{aucune_donnee:''}];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(list), sheetName(key));
      });
      var date = new Date().toISOString().slice(0,10);
      XLSX.writeFile(wb, 'sci-family-export-global-' + slug(safeEntityName()) + '-' + date + '.xlsx');
      if(typeof window.toast === 'function') window.toast('Export Excel créé ✓');
    }catch(err){
      console.error('Export Excel SCI Family impossible', err);
      if(typeof window.toast === 'function') window.toast('Export Excel impossible : ' + (err.message || err));
      else alert('Export Excel impossible : ' + (err.message || err));
    }
  };
})();
