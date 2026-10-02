import { initializeApp } from "firebase/app";
import { getStorage, ref, getDownloadURL } from "firebase/storage";

const firebaseConfig = {
  projectId: "skip-bigotes",
  appId: "1:1033289992711:web:4a490808d63b933a08f8a2",
  storageBucket: "skip-bigotes.firebasestorage.app",
  apiKey: "AIzaSyB0ihpyYO-jBnsYF4x9Uy77WbgpwqVPYUo",
  authDomain: "skip-bigotes.firebaseapp.com",
  messagingSenderId: "1033289992711",
  measurementId: "G-3369KSG3CS"
};

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);

async function test() {
  console.log("Testing getDownloadURL for camera_catcher/photos/photo_1790918710217.jpg...");
  const storageRef = ref(storage, "camera_catcher/photos/photo_1790918710217.jpg");
  const url = await getDownloadURL(storageRef);
  console.log("SUCCESS! Download URL resolved:", url);
}

test().catch((err) => {
  console.error("FAILURE:", err);
});
