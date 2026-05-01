interface Props {
  basePath: string;
}

export default function NewCustomerCard({ basePath }: Props) {
  return (
    <section className="mb-newcust" aria-labelledby="mb-newcust-heading">
      <span className="mb-newcust__eyebrow">Welcome</span>
      <h2 id="mb-newcust-heading">Book your next visit</h2>
      <p className="mb-newcust__sub">
        Choose your service, barber, and time in just a few taps.
      </p>
      <a className="mb-btn" href={`${basePath}/book`}>
        Start Booking
      </a>
    </section>
  );
}
