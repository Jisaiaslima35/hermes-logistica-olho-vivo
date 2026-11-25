import { useState } from 'react';

/**
 * Modo Kiosk: Tela escurecida para economia de bateria e redução de distrações
 * durante a condução, mantendo o Foreground Service ativo em segundo plano.
 */
export function useKioskMode() {
  const [isKioskActive, setIsKioskActive] = useState(false);

  const activateKiosk = () => {
    setIsKioskActive(true);
  };

  const deactivateKiosk = () => {
    setIsKioskActive(false);
  };

  const toggleKiosk = () => {
    setIsKioskActive(prev => !prev);
  };

  return {
    isKioskActive,
    activateKiosk,
    deactivateKiosk,
    toggleKiosk
  };
}

export default useKioskMode;
