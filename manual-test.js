const button = document.querySelector("#open-popup");
const guide = document.querySelector("#guide");
const isTestPopup = new URLSearchParams(location.search).has("popup");

if (isTestPopup) {
  document.title = "Popup as Tab Test Result";
  guide.textContent = "The test passes if this tab moved directly to the right of the original test tab and became active.";
  button.hidden = true;
} else {
  button.addEventListener("click", () => {
    const popupUrl = new URL(location.href);
    popupUrl.searchParams.set("popup", "1");
    window.open(popupUrl, "_blank", "popup=yes,width=480,height=320");
  });
}
