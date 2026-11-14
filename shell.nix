# Uses this machine's selected Nixpkgs channel. Browser is optional because its
# system closure is larger; Bun's application dependencies remain lock-pinned.
{ pkgs ? import <nixpkgs> {}, withBrowser ? false }:
pkgs.mkShell {
  packages = with pkgs; [ bun git jujutsu jq ripgrep fd bashInteractive curl ]
    ++ pkgs.lib.optional withBrowser pkgs.chromium;
  shellHook = ''
    export BUN_INSTALL_CACHE_DIR="''${BUN_INSTALL_CACHE_DIR:-/tmp/laun-bun-cache}"
    export PATH="$PWD/node_modules/.bin:$HOME/.local/bin:$PATH"
    ${pkgs.lib.optionalString withBrowser ''
      export CHROMIUM_BIN="${pkgs.chromium}/bin/chromium"
      export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$CHROMIUM_BIN"
    ''}
    printf 'Laun development shell: Bun %s; use bun run build and bun run test.\n' "$(bun --version)"
  '';
}
