import React, { useEffect, useState } from "react";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

export default function Root({ children }: { children: React.ReactNode }) {
  const { i18n } = useDocusaurusContext();
  const isZH = i18n.currentLocale === "zh-CN";
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target && target.closest(".contact-author-btn")) {
        e.preventDefault();
        e.stopPropagation();
        setIsModalOpen(true);
      }
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  const handleCopyWeChat = async () => {
    try {
      await navigator.clipboard.writeText("blue_elephant_in_sky");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2000);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  };

  return (
    <>
      {children}
      {isModalOpen && (
        <div style={modalOverlayStyle} onClick={() => setIsModalOpen(false)}>
          <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}>
            <button style={closeBtnStyle} onClick={() => setIsModalOpen(false)}>
              ×
            </button>
            <h2 style={{ marginTop: 0, color: "#333", textAlign: "center" }}>
              {isZH ? "🎉 欢迎交流" : "🎉 Welcome"}
            </h2>

            <div style={{ marginTop: "20px", marginBottom: "20px" }}>
              <p
                style={{
                  color: "#555",
                  lineHeight: 1.6,
                  fontSize: "clamp(0.875rem, 2vw + 0.5rem, 1rem)",
                  margin: "0",
                }}
              >
                {isZH
                  ? "我是 Ocean Chat 的作者。如果您在对接时遇到任何阻碍，或者寻求技术交流，请添加我的微信："
                  : "I am the author of Ocean Chat. If you need any help or technical discussion, please follow our X account:"}
              </p>
            </div>

            {isZH ? (
              <div style={wechatContainerStyle}>
                <span
                  style={{
                    fontSize: "clamp(1rem, 3vw + 0.5rem, 1.5rem)",
                    fontWeight: "bold",
                    color: "#10a37f",
                    wordBreak: "break-all",
                  }}
                >
                  blue_elephant_in_sky
                </span>
                <button style={copyBtnStyle} onClick={handleCopyWeChat}>
                  复制微信号
                </button>
              </div>
            ) : (
              <div style={wechatContainerStyle}>
                <span
                  style={{
                    fontSize: "clamp(1rem, 3vw + 0.5rem, 1.5rem)",
                    fontWeight: "bold",
                    color: "#10a37f",
                    wordBreak: "break-all",
                  }}
                >
                  x.com/OceanChat
                </span>
                <button
                  style={copyBtnStyle}
                  onClick={() =>
                    window.open("https://x.com/OceanChat", "_blank")
                  }
                >
                  X
                </button>
              </div>
            )}

            {showToast && (
              <>
                <style>{`
                  @keyframes toastFadeOut {
                    0% { opacity: 1; }
                    50% { opacity: 1; }
                    100% { opacity: 0; }
                  }
                `}</style>
                <div style={{ ...toastStyle, animation: "toastFadeOut 2s forwards" }}>
                  复制成功！
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 99999, // very high z-index
  backdropFilter: "blur(4px)",
};

const modalContentStyle: React.CSSProperties = {
  backgroundColor: "#fff",
  padding: "32px",
  borderRadius: "12px",
  width: "90%",
  maxWidth: "450px",
  boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
  position: "relative",
  textAlign: "left",
};

const closeBtnStyle: React.CSSProperties = {
  position: "absolute",
  top: "12px",
  right: "16px",
  background: "none",
  border: "none",
  fontSize: "24px",
  cursor: "pointer",
  color: "#999",
};

const wechatContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  marginTop: "24px",
  padding: "16px",
  backgroundColor: "#f5f7f9",
  borderRadius: "8px",
  flexWrap: "wrap",
  gap: "16px",
};

const copyBtnStyle: React.CSSProperties = {
  backgroundColor: "#10a37f",
  color: "white",
  border: "none",
  padding: "8px 16px",
  borderRadius: "4px",
  cursor: "pointer",
  fontWeight: "bold",
  transition: "background-color 0.2s",
  whiteSpace: "nowrap",
};

const toastStyle: React.CSSProperties = {
  position: "absolute",
  top: "20px",
  left: "50%",
  transform: "translateX(-50%)",
  backgroundColor: "#333",
  color: "#fff",
  padding: "8px 16px",
  borderRadius: "4px",
  fontSize: "14px",
  zIndex: 100000,
  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
};
