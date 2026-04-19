import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebar: SidebarsConfig = {
  apisidebar: [
    {
      type: "doc",
      id: "devdocs/API/ocean-chat-api",
    },
    {
      type: "category",
      label: "Auth",
      items: [
        {
          type: "doc",
          id: "devdocs/API/auth-controller-login",
          label: "AuthController_login",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "devdocs/API/auth-controller-register",
          label: "AuthController_register",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "devdocs/API/auth-controller-refresh",
          label: "AuthController_refresh",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "devdocs/API/auth-controller-logout",
          label: "AuthController_logout",
          className: "api-method post",
        },
      ],
    },
    {
      type: "category",
      label: "Users",
      items: [
        {
          type: "doc",
          id: "devdocs/API/users-controller-get-my-profile",
          label: "UsersController_getMyProfile",
          className: "api-method get",
        },
      ],
    },
  ],
};

export default sidebar.apisidebar;
