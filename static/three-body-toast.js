const toast = document.getElementById("tb-toast");
let hideTimer;

export function showToast(message) {
    clearTimeout(hideTimer);
    toast.textContent = message;
    hideTimer = setTimeout(() => {
        toast.textContent = "";
    }, 5000);
}
