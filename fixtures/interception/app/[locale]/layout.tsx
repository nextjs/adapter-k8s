export default function LocaleLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <main>
      <div id="children">{children}</div>
      <div id="modal">{modal}</div>
    </main>
  );
}
