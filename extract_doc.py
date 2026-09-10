import sys
import json
from pypdf import PdfReader
import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup

def extract_document_info(file_path):
    data = {"title": None, "text_chunk": ""}
    try:
        if file_path.lower().endswith('.pdf'):
            reader = PdfReader(file_path)
            data["title"] = reader.metadata.title if reader.metadata else None
            # Grab first 2 pages of text content
            text = ""
            pages_to_read = min(len(reader.pages), 2)
            for i in range(pages_to_read):
                text += reader.pages[i].extract_text() or ""
            data["text_chunk"] = text

        elif file_path.lower().endswith('.epub'):
            book = epub.read_epub(file_path)
            data["title"] = book.get_metadata('DC', 'title')[0][0] if book.get_metadata('DC', 'title') else None
            # Grab content from the first body element
            text = ""
            for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
                soup = BeautifulSoup(item.get_body_content(), 'html.parser')
                text += soup.get_text()
                if len(text) > 2000:
                    break
            data["text_chunk"] = text
    except:
        pass

    print(json.dumps(data))

if __name__ == "__main__":
    if len(sys.argv) > 1:
        extract_document_info(sys.argv[1])
