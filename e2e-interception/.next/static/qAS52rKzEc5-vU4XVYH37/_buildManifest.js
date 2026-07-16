self.__BUILD_MANIFEST = {
  "__rewrites": {
    "afterFiles": [],
    "beforeFiles": [
      {
        "has": [
          {
            "type": "header",
            "key": "next-url",
            "value": "/(?<nxtPlocale>[^/]+?)(?:/.*)?"
          }
        ],
        "source": "/:nxtPlocale/:nxtIusername/p/:nxtPid",
        "destination": "/:nxtPlocale/(.):nxtIusername/p/:nxtPid"
      }
    ],
    "fallback": []
  },
  "sortedPages": [
    "/_app",
    "/_error"
  ]
};self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()