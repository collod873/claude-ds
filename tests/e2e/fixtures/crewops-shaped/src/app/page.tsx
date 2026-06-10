import { SearchBox } from "@ds/composites/SearchBox";
import { ResultList } from "@/design-system/composites/ResultList";

export default function Page() {
  return (
    <main>
      <SearchBox />
      <ResultList />
    </main>
  );
}
