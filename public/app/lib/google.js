// Google's sign-in button. Google's script loads on demand, and the button only
// works on an origin registered on the client (localhost:3002 today).

const CLIENT_ID = "831633636977-5udfv455pim2mgnequj8boivlck30hun.apps.googleusercontent.com";
let loading = null;

function loadScript() {
  if (window.google?.accounts?.id) {
    return Promise.resolve();
  }
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      loading = null;
      reject(new Error("Google's sign-in script did not load"));
    };
    document.head.append(script);
  });
  return loading;
}

/** Draw Google's button into `slot`; `onToken` gets the ID token after a pick. */
export async function renderGoogleButton(slot, text, onToken) {
  try {
    await loadScript();
  } catch {
    slot.textContent = "Google sign-in is unavailable right now.";
    return;
  }
  if (!slot.isConnected) {
    return;
  }
  window.google.accounts.id.initialize({ client_id: CLIENT_ID, callback: (response) => onToken(response.credential) });
  window.google.accounts.id.renderButton(slot, {
    theme: "filled_black",
    size: "large",
    shape: "rectangular",
    text: text,
    width: Math.min(slot.clientWidth || 360, 400),
  });
}
