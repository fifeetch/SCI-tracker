importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCssgfhnAkaaP4TQxTyi5amY_C_ztrJeds",
  authDomain: "sci-family-ab82c.firebaseapp.com",
  projectId: "sci-family-ab82c",
  storageBucket: "sci-family-ab82c.firebasestorage.app",
  messagingSenderId: "339961639799",
  appId: "1:339961639799:web:0ca110231758437021a772"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || payload?.data?.title || 'SCI Family';
  const options = {
    body: payload?.notification?.body || payload?.data?.body || 'Nouvelle alerte SCI Family',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    data: {
      url: payload?.data?.url || '/'
    }
  };
  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';
  event.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then((clientList) => {
      for(const client of clientList){
        if('focus' in client){
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
