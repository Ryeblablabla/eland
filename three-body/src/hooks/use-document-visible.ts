import { useEffect, useState } from 'react';

/** 页面不可见时暂停自动演化；回到前台后从同一权威月份继续。 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  return visible;
}
