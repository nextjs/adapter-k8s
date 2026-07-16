export default function Boom() {
  return <main>This should never render</main>;
}

Boom.getInitialProps = () => {
  throw new Error("local Pages error probe");
};
